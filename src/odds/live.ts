import { publish, subscribe } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import type { MatchRepository } from "../lib/match-repository.js";
import { matchRepository } from "../lib/match-store.js";
import { computeMatchStats } from "./stats.js";
import { priceMatch } from "./pricer.js";
import { LIVE_SIMULATIONS, REPRICE_INTERVAL_MS, SUSPENSION_MS } from "./config.js";
import { marketsRepository, type MarketsRepository } from "./markets-store.js";

/**
 * The live side: what the markets do while a match is being played.
 *
 * Three rules keep the book honest in play.
 *
 * 1. A shot can change everything, so every market is suspended the moment one
 *    is played, and repriced underneath the suspension.
 * 2. A match is repriced at most once a second, and a repricing that is already
 *    stale when it starts is dropped rather than written over newer numbers.
 * 3. Markets that do not belong in play are closed when the match goes live, and
 *    nothing is settled here: when the match ends the engine publishes the stats
 *    and the betting side settles.
 */

export interface OddsEngineOptions {
  readonly repository?: MarketsRepository;
  readonly matches?: MatchRepository;
  readonly repriceIntervalMs?: number;
  readonly suspensionMs?: number;
  readonly simulations?: number;
  readonly now?: () => number;
  readonly clock?: {
    setTimeout: (callback: () => void, delayMs: number) => { cancel: () => void };
  };
}

export interface OddsEngine {
  /** Stops listening. Safe to call twice. */
  stop(): void;
  /** For tests: waits for any repricing in flight. */
  idle(): Promise<void>;
}

type CarromGame = "carrom" | "ludo";

const defaultClock = {
  setTimeout(callback: () => void, delayMs: number): { cancel: () => void } {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Prices a match once, and again after every shot, within the rules above. */
export function attachOddsEngine(options: OddsEngineOptions = {}): OddsEngine {
  const repository = options.repository ?? marketsRepository();
  const matches = options.matches ?? matchRepository();
  const repriceIntervalMs = options.repriceIntervalMs ?? REPRICE_INTERVAL_MS;
  const suspensionMs = options.suspensionMs ?? SUSPENSION_MS;
  const simulations = options.simulations ?? LIVE_SIMULATIONS;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? defaultClock;

  const lastPriceAt = new Map<string, number>();
  const pending = new Map<string, { shotNumber: number; at: number }>();
  const suspensions = new Map<string, { cancel: () => void }>();
  const inFlight = new Set<Promise<void>>();
  const unsubscribes: (() => void)[] = [];
  let stopped = false;

  const closeInPlay = async (matchId: string): Promise<void> => {
    // Markets that cannot be settled once the board is moving are closed, not
    // left open at a pre-match price: an open price on a market nobody can judge
    // is a guarantee someone takes advantage of.
    await repository.setStatus(matchId, "closed", { live: false });
  };

  const reprice = (matchId: string, shotNumber: number, game: CarromGame): void => {
    if (stopped) {
      return;
    }

    const startedAt = now();
    const last = lastPriceAt.get(matchId) ?? 0;

    if (startedAt - last < repriceIntervalMs) {
      // Remember the newest shot, and reprice once the second is up.
      pending.set(matchId, { shotNumber, at: startedAt });
      return;
    }

    lastPriceAt.set(matchId, startedAt);

    const job = (async () => {
      try {
        await repository.setStatus(matchId, "suspended");
        await priceMatch(matchId, {
          simulations,
          repository,
          matches,
          status: "suspended",
          seedPrefix: `${matchId}:live`,
        });
        logger.debug({ matchId, shotNumber, game }, "repriced in play");
      } catch (error) {
        logger.warn({ matchId, err: error }, "could not reprice the match");
      } finally {
        suspensions.get(matchId)?.cancel();
        const suspension = clock.setTimeout(() => {
          suspensions.delete(matchId);
          // A newer shot is already queued: stay shut until it has been priced.
          if (pending.has(matchId)) {
            return;
          }
          void repository.setStatus(matchId, "open").catch((error: unknown) => {
            logger.warn({ matchId, err: error }, "could not reopen the markets");
          });
        }, suspensionMs);
        suspensions.set(matchId, suspension);
      }
    })();

    inFlight.add(job);
    void job.finally(() => {
      inFlight.delete(job);
    });
  };

  /**
   * The newest shot wins: when the throttle allows the next reprice it prices
   * whatever the shot count has reached by then, never an older state.
   */
  const flushPending = (matchId: string): void => {
    const queued = pending.get(matchId);
    if (queued === undefined) {
      return;
    }
    const last = lastPriceAt.get(matchId) ?? 0;
    if (now() - last < repriceIntervalMs) {
      return;
    }
    pending.delete(matchId);
    reprice(matchId, queued.shotNumber, "carrom");
  };

  const ticker = setInterval(() => {
    for (const matchId of pending.keys()) {
      flushPending(matchId);
    }
  }, repriceIntervalMs);
  ticker.unref();

  unsubscribes.push(
    subscribe("match.created", (payload) => {
      const job = priceMatch(payload.matchId, { repository, matches }).then(
        () => {
          logger.info({ matchId: payload.matchId }, "priced a new match");
        },
        (error: unknown) => {
          logger.warn({ matchId: payload.matchId, err: error }, "could not price a new match");
        },
      );
      inFlight.add(job);
      void job.finally(() => inFlight.delete(job));
    }),
  );

  unsubscribes.push(
    subscribe("match.live", (payload) => {
      const job = closeInPlay(payload.matchId).then(
        () => undefined,
        (error: unknown) => {
          logger.warn(
            { matchId: payload.matchId, err: error },
            "could not close pre-match markets",
          );
        },
      );
      inFlight.add(job);
      void job.finally(() => inFlight.delete(job));
    }),
  );

  unsubscribes.push(
    subscribe("match.shot", (payload) => {
      reprice(payload.matchId, payload.shotNumber, payload.game);
    }),
  );

  unsubscribes.push(
    subscribe("match.finished", (payload) => {
      const job = (async () => {
        try {
          const events = await matches.listEvents(payload.matchId);
          const stats = computeMatchStats(payload.matchId, events);
          await repository.setStatus(payload.matchId, "closed");
          await publish("markets.ready_to_settle", {
            matchId: payload.matchId,
            game: payload.game,
            winner: stats.winner,
            boardsPlayed: stats.boardsPlayed,
            totalPoints: stats.totalPoints,
            totalFouls: stats.totalFouls,
          });
        } catch (error) {
          logger.warn({ matchId: payload.matchId, err: error }, "could not hand the markets over");
        }
      })();
      inFlight.add(job);
      void job.finally(() => inFlight.delete(job));
    }),
  );

  return {
    stop(): void {
      stopped = true;
      clearInterval(ticker);
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      for (const suspension of suspensions.values()) {
        suspension.cancel();
      }
      suspensions.clear();
      pending.clear();
    },
    async idle(): Promise<void> {
      await Promise.all([...inFlight]);
    },
  };
}
