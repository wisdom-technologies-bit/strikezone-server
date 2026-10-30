import { publish, subscribe } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import type { MatchRepository } from "../lib/match-repository.js";
import { matchRepository } from "../lib/match-store.js";
import { computeMatchStats } from "./stats.js";
import { priceMatch } from "./pricer.js";
import { priceLudoMatch } from "./ludo-pricer.js";
import { computeLudoStats, replayLudoLog } from "./ludo-stats.js";
import type { LudoState } from "../engines/ludo/index.js";
import { LIVE_SIMULATIONS, REPRICE_INTERVAL_MS, SUSPENSION_MS } from "./config.js";
import { LUDO_PRICE_BUDGET_MS as LUDO_PREMATCH_BUDGET_MS } from "./ludo-pricer.js";
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
  /** Matches simulated for a live reprice. Defaults to the config's 5,000. */
  readonly simulations?: number;
  /**
   * Matches simulated for the pre-match price. Defaults to the config's 100,000;
   * tests lower it because a test needs the shape, not the precision.
   */
  readonly preMatchSimulations?: number;
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

type Game = "carrom" | "ludo";

/**
 * A log entry's payload, whichever field the repository puts it in.
 *
 * The Ludo replay reads `{ type, payload }`, and this is the one place that
 * touches a stored entry's shape: everything downstream reads the engine's own
 * log type.
 */
function payloadOf(entry: {
  readonly payload?: unknown;
  readonly data?: unknown;
}): Record<string, unknown> {
  const value = entry.payload ?? entry.data;
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

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
  const preMatchSimulations = options.preMatchSimulations;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? defaultClock;

  const lastPriceAt = new Map<string, number>();
  const pending = new Map<string, { shotNumber: number; at: number; game: Game }>();
  const suspensions = new Map<string, { cancel: () => void }>();
  /**
   * Matches that are over. A shot's reprice reopens the book two seconds later,
   * and that timer can outlive the finish: without this the last shot of a match
   * would reopen a closed market a moment after the result was known.
   */
  const finishedMatches = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const unsubscribes: (() => void)[] = [];
  let stopped = false;

  const closeInPlay = async (matchId: string): Promise<void> => {
    // Markets that cannot be settled once the board is moving are closed, not
    // left open at a pre-match price: an open price on a market nobody can judge
    // is a guarantee someone takes advantage of.
    await repository.setStatus(matchId, "closed", { live: false });
  };

  /**
   * What happens when a price has been written: close a finished match's book,
   * or schedule the reopen. Kept out of the finally block so a reprice's outcome
   * is never swallowed by a return.
   */
  const settleSuspension = (matchId: string): void => {
    if (finishedMatches.has(matchId)) {
      // The match ended while this price was being computed. Its rows were
      // written suspended; close them rather than open a finished match.
      void repository.setStatus(matchId, "closed").catch((error: unknown) => {
        logger.warn({ matchId, err: error }, "could not close the markets");
      });
      return;
    }

    const suspension = clock.setTimeout(() => {
      suspensions.delete(matchId);
      // A newer shot is already queued: stay shut until it has been priced.
      if (pending.has(matchId) || finishedMatches.has(matchId)) {
        return;
      }
      void repository.setStatus(matchId, "open").catch((error: unknown) => {
        logger.warn({ matchId, err: error }, "could not reopen the markets");
      });
    }, suspensionMs);
    suspensions.set(matchId, suspension);
  };

  /**
   * The board a Ludo match has reached, or undefined when it cannot be read.
   *
   * A live price resumes from here, which is the whole point of pricing in play:
   * a seat with three tokens home must not be priced as if the game had not
   * started. A log that will not replay is not a reason to keep a stale price, so
   * the reprice falls back to the opening position and says so in the log.
   */
  const ludoPosition = async (matchId: string): Promise<LudoState | undefined> => {
    try {
      const entries = await matches.listEvents(matchId);
      const replay = replayLudoLog(
        entries.map((entry) => ({ type: entry.type, payload: payloadOf(entry) })),
      );
      return replay.state.status === "playing" ? replay.state : undefined;
    } catch (error) {
      logger.warn(
        { matchId, err: error },
        "could not read the ludo position: pricing from the opening",
      );
      return undefined;
    }
  };

  /** One repricing, by the game that owns the book. */
  const price = async (
    matchId: string,
    game: Game,
    options: {
      readonly live: boolean;
      readonly status: "open" | "suspended";
      readonly seed: string;
    },
  ): Promise<void> => {
    if (game === "ludo") {
      const resume = options.live ? await ludoPosition(matchId) : undefined;
      await priceLudoMatch(matchId, {
        repository,
        matches,
        simulations,
        status: options.status,
        seed: options.seed,
        ...(resume === undefined ? {} : { resume }),
      });
      return;
    }

    await priceMatch(matchId, {
      simulations,
      repository,
      matches,
      status: options.status,
      seedPrefix: options.seed,
    });
  };

  const reprice = (matchId: string, shotNumber: number, game: Game): void => {
    if (stopped || finishedMatches.has(matchId)) {
      return;
    }

    const startedAt = now();
    const last = lastPriceAt.get(matchId) ?? 0;

    if (startedAt - last < repriceIntervalMs) {
      // Remember the newest shot, and reprice once the second is up.
      pending.set(matchId, { shotNumber, at: startedAt, game });
      return;
    }

    lastPriceAt.set(matchId, startedAt);

    const job = (async () => {
      try {
        await repository.setStatus(matchId, "suspended");
        await price(matchId, game, {
          live: true,
          status: "suspended",
          seed: `${matchId}:live`,
        });
        logger.debug({ matchId, shotNumber, game }, "repriced in play");
      } catch (error) {
        logger.warn({ matchId, err: error }, "could not reprice the match");
      } finally {
        suspensions.get(matchId)?.cancel();
        settleSuspension(matchId);
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
    reprice(matchId, queued.shotNumber, queued.game);
  };

  const ticker = setInterval(() => {
    for (const matchId of pending.keys()) {
      flushPending(matchId);
    }
  }, repriceIntervalMs);
  ticker.unref();

  unsubscribes.push(
    subscribe("match.created", (payload) => {
      const job = (async () => {
        const match = await matches.get(payload.matchId);
        const game: Game = match?.game === "ludo" ? "ludo" : "carrom";
        if (game === "ludo") {
          // A Ludo price is a million games unless the budget says otherwise, and
          // the pricer decides that itself.
          await priceLudoMatch(payload.matchId, {
            repository,
            matches,
            ...(preMatchSimulations === undefined ? {} : { simulations: preMatchSimulations }),
            ...(preMatchSimulations === undefined ? { budgetMs: LUDO_PREMATCH_BUDGET_MS } : {}),
          });
          return;
        }
        await priceMatch(payload.matchId, {
          repository,
          matches,
          ...(preMatchSimulations === undefined ? {} : { simulations: preMatchSimulations }),
        });
      })().then(
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
      finishedMatches.add(payload.matchId);
      pending.delete(payload.matchId);
      suspensions.get(payload.matchId)?.cancel();
      suspensions.delete(payload.matchId);

      const job = (async () => {
        try {
          await Promise.all([...inFlight]);
          const events = await matches.listEvents(payload.matchId);
          await repository.setStatus(payload.matchId, "closed");

          if (payload.game === "ludo") {
            const ludo = computeLudoStats(
              events.map((entry) => ({ type: entry.type, payload: payloadOf(entry) })),
            );
            await publish("markets.ready_to_settle", {
              matchId: payload.matchId,
              game: "ludo",
              winner: ludo.winnerSeat,
              boardsPlayed: 0,
              totalPoints: 0,
              totalFouls: 0,
              finishingOrder: ludo.finishingOrder,
              finalHome: ludo.finalHome,
            });
            return;
          }

          const stats = computeMatchStats(payload.matchId, events);
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
