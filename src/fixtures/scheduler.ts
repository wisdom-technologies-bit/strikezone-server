import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import type { MatchRepository, MatchRecord, MatchResult } from "../lib/match-repository.js";
import type { MarketsRepository } from "../odds/markets-store.js";
import { commitOf, verifyCommit } from "../lib/fair-rng.js";
import { publish, type EventPayloads } from "../lib/events.js";
import type { MatchLauncher } from "../tournaments/launcher.js";
import { fixturePlanFor } from "./roster.js";
import { priceFixture, type FixturePriceReport } from "./pricing.js";
import { fixtureSeed } from "./seed.js";
import type { FixturesRepository } from "./repository.js";
import type {
  FixtureGame,
  FixturePlan,
  FixtureTickReport,
  FixturesConfig,
  StoredFixture,
} from "./types.js";

/**
 * The house fixtures journal.
 *
 * The lobby needs something to bet on at every hour a person might look at it, and
 * nobody is going to create bot matches by hand at three in the morning. This job
 * keeps a rolling set of them: `UPCOMING_FIXTURES_TARGET` matches in `scheduled`,
 * spaced `FIXTURE_INTERVAL_MINUTES` apart, alternating games, each priced when it
 * is created and played by bots when its time comes.
 *
 * Three properties, borrowed from the tournament scheduler because they are the
 * ones that matter:
 *
 * 1. **Safe to run twice.** A lease decides which instance ticks, and every write
 *    is conditional on the state it was read in: a fixture is created only when the
 *    set is short, and started only when the match is still `scheduled`.
 * 2. **Resumes.** Nothing lives in memory that cannot be rebuilt: the fixtures are
 *    match rows, the pause is a row, and a fixture's seed is derived from its id,
 *    so a process that died between pricing a match and starting it can pick both
 *    up again from the database alone.
 * 3. **Never exceeds its share.** No more than `MAX_CONCURRENT_HOUSE_MATCHES` bot
 *    matches run at once. When the cap is reached a due fixture waits, and the
 *    wait is logged; nothing is dropped.
 */

/** The two events a fixture publishes, typed to the bus. */
export type FixtureEventName = "match.live" | "match.finished";

export interface FixtureEventPublisher {
  <N extends FixtureEventName>(name: N, payload: EventPayloads[N]): Promise<void>;
}

/** The lease: one instance runs a tick. */
export interface FixtureLease {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** An in-process lease, for tests and a single-process server. */
export class InMemoryFixtureLease implements FixtureLease {
  #held = false;

  async acquire(): Promise<boolean> {
    if (this.#held) {
      return false;
    }
    this.#held = true;
    return true;
  }

  async release(): Promise<void> {
    this.#held = false;
  }
}

/** The lease name and advisory lock key for this job, separate from the tournaments'. */
export const FIXTURE_LEASE_NAME = "house_fixture_scheduler";
export const FIXTURE_LEASE_LOCK_KEY = 0x5374_5a48; // "StZH"

export interface FixtureSchedulerDeps {
  readonly config: FixturesConfig;
  readonly repository: FixturesRepository;
  readonly matches: MatchRepository;
  readonly markets: MarketsRepository;
  readonly launcher: MatchLauncher;
  readonly lease: FixtureLease;
  /** The secret a fixture's seed is derived from. */
  readonly secret: string;
  /** Prices one fixture. Defaults to the real pricer with its time budget. */
  readonly price?: (matchId: string, game: FixtureGame) => Promise<FixturePriceReport>;
  /** How events leave the scheduler. Defaults to the process event bus. */
  readonly publish?: FixtureEventPublisher;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  /** Turn clock handed to the room. Ten seconds is plenty for a bot. */
  readonly turnSeconds?: number;
}

const EMPTY: FixtureTickReport = {
  skipped: false,
  created: 0,
  started: 0,
  delayed: 0,
  settled: 0,
  priced: 0,
};

/** How far back the startup sweep looks for fixtures that finished while we were down. */
const RESUME_SWEEP_HOURS = 6;

export class HouseFixturesScheduler {
  readonly #deps: FixtureSchedulerDeps;
  readonly #config: FixturesConfig;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  /** Fixtures this process priced, so a start does not price twice. */
  readonly #priced = new Set<string>();
  /** Fixtures this process launched and has not yet handed to settlement. */
  readonly #launched = new Set<string>();

  constructor(deps: FixtureSchedulerDeps) {
    this.#deps = deps;
    this.#config = deps.config;
  }

  /** Runs once, under the lease. */
  async tick(): Promise<FixtureTickReport> {
    if (!this.#config.enabled || this.#running) {
      return { ...EMPTY, skipped: true };
    }
    this.#running = true;

    try {
      const acquired = await this.#deps.lease.acquire();
      if (!acquired) {
        return { ...EMPTY, skipped: true };
      }

      try {
        return await this.#work();
      } finally {
        await this.#deps.lease.release();
      }
    } catch (error) {
      logger.error({ err: error }, "house fixtures tick failed");
      return { ...EMPTY, skipped: true };
    } finally {
      this.#running = false;
    }
  }

  /**
   * Startup: hand over anything that finished while we were down, then tick.
   *
   * The sweep is bounded and idempotent. Settlement re-runs safely, so a match
   * that finished before a restart is settled rather than orphaned, and a match
   * that was already settled is reported again and pays nobody twice.
   */
  async resume(): Promise<FixtureTickReport> {
    if (!this.#config.enabled) {
      return { ...EMPTY, skipped: true };
    }

    const since = new Date(this.#nowMs() - RESUME_SWEEP_HOURS * 3_600_000).toISOString();
    try {
      const finished = await this.#deps.repository.listRecentlyFinished(since, 10);
      for (const fixture of finished) {
        await this.#handOver(fixture.id);
      }
    } catch (error) {
      logger.warn({ err: error }, "could not sweep finished fixtures on resume");
    }

    const report = await this.tick();
    logger.info({ ...report }, "house fixtures scheduler resumed");
    return report;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    const intervalMs = this.#deps.intervalMs ?? 15_000;
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        logger.error({ err: error }, "house fixtures tick failed");
      });
    }, intervalMs);
    this.#timer.unref();
    logger.info(
      { intervalMs, target: this.#config.target, games: this.#config.games },
      "house fixtures scheduler started",
    );
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #work(): Promise<FixtureTickReport> {
    const nowMs = this.#nowMs();
    const paused = await this.#deps.repository.isPaused();

    // Everything that finished since the last tick goes to settlement first, so
    // the running count below is honest.
    const settled = await this.#handOverLaunched();

    const upcoming = await this.#deps.repository.listUpcoming(this.#config.target * 3 + 4);
    const running = await this.#deps.repository.listRunning();
    let runningCount = running.length;

    let started = 0;
    let delayed = 0;
    const waiting: StoredFixture[] = [];

    for (const fixture of upcoming) {
      const at = fixture.scheduledAt === null ? nowMs : Date.parse(fixture.scheduledAt);
      if (Number.isNaN(at) || at > nowMs) {
        waiting.push(fixture);
        continue;
      }

      if (runningCount >= this.#config.maxConcurrent) {
        // A small host can only play so many games at once. The fixture keeps its
        // place in the queue; the next tick starts it as soon as a room frees up.
        delayed += 1;
        waiting.push(fixture);
        continue;
      }

      const launched = await this.#start(fixture);
      if (launched) {
        runningCount += 1;
        started += 1;
      } else {
        waiting.push(fixture);
      }
    }

    if (delayed > 0) {
      logger.warn(
        { delayed, running: runningCount, cap: this.#config.maxConcurrent },
        "house fixtures are waiting for a free slot",
      );
    }

    let created = 0;
    let priced = 0;

    if (!paused) {
      const missing = Math.max(0, this.#config.target - waiting.length);
      // The anchor is the last fixture still to come, or now when there is none:
      // a cold start opens the first window immediately rather than waiting a
      // whole interval for something to bet on.
      const latest = waiting.reduce<number>((furthest, fixture) => {
        const at = fixture.scheduledAt === null ? 0 : Date.parse(fixture.scheduledAt);
        return Number.isNaN(at) ? furthest : Math.max(furthest, at);
      }, 0);
      let anchor = Math.max(nowMs, latest);

      for (let index = 0; index < missing; index += 1) {
        const gapMs =
          waiting.length === 0 && index === 0 && latest === 0
            ? this.#config.betWindowSeconds * 1_000
            : this.#config.intervalMinutes * 60_000;
        const slotMs = anchor + gapMs;
        anchor = slotMs;

        const price = await this.#create(slotMs);
        if (price !== null) {
          created += 1;
          priced += 1;
        }
      }
    }

    if (created + started + settled > 0) {
      logger.info({ created, started, settled, paused, waiting: waiting.length }, "fixture tick");
    }

    return { skipped: false, created, started, delayed, settled, priced };
  }

  /**
   * Creates and prices the fixture for one start time.
   *
   * Returns null when the fixture could not be priced: a scheduled match whose
   * markets are empty is a lobby row with nothing to bet on, so it is created and
   * priced together or not at all. On failure the row is left `scheduled`; the
   * start path prices it again before launching, which is what makes a saturated
   * host delay a match rather than skip its price.
   */
  async #create(slotMs: number): Promise<FixturePriceReport | null> {
    const plan = this.#planFor(slotMs);
    const id = randomUUID();
    const seed = fixtureSeed(id, this.#deps.secret);

    try {
      const match = await this.#deps.matches.create({
        id,
        game: plan.game,
        seedCommit: commitOf(seed),
        seats: plan.seats,
        config: plan.config,
        scheduledAt: new Date(slotMs).toISOString(),
      });

      const report = await this.#price(match.id, plan.game);
      this.#priced.add(match.id);
      logger.info(
        {
          matchId: match.id,
          game: plan.game,
          scheduledAt: new Date(slotMs).toISOString(),
          seats: plan.seats.map((seat) => seat.displayName),
          simulations: report.simulations,
          reduced: report.reduced,
          elapsedMs: Math.round(report.elapsedMs),
        },
        "house fixture created and priced",
      );
      return report;
    } catch (error) {
      logger.error({ err: error, game: plan.game }, "could not create a house fixture");
      return null;
    }
  }

  /** The plan for a start time: the game alternates by slot, so it is stateless. */
  #planFor(slotMs: number): FixturePlan {
    const intervalMs = this.#config.intervalMinutes * 60_000;
    const slot = Math.floor(slotMs / intervalMs);
    return fixturePlanFor(this.#config.games, slot);
  }

  /** Starts one fixture: price if needed, close the book that cannot go live, launch. */
  async #start(fixture: StoredFixture): Promise<boolean> {
    const match = await this.#deps.matches.get(fixture.id);
    if (match === null || match.status !== "scheduled") {
      return false;
    }

    const seed = fixtureSeed(match.id, this.#deps.secret);
    if (match.seedCommit === null || !verifyCommit(seed, match.seedCommit)) {
      logger.error(
        { matchId: match.id },
        "a fixture's commitment does not match its seed: refusing to start it",
      );
      return false;
    }

    if (!this.#priced.has(match.id)) {
      // A restart, or a fixture created by the other instance. Price it now, and
      // accept the wait: an unpriced match cannot be bet on and must not start.
      try {
        await this.#price(match.id, match.game === "ludo" ? "ludo" : "carrom");
        this.#priced.add(match.id);
      } catch (error) {
        logger.error(
          { err: error, matchId: match.id },
          "could not price a fixture: not starting it",
        );
        return false;
      }
    }

    try {
      // The markets that cannot be settled once the board moves are closed before
      // the room opens, so nobody takes a stale pre-match price into play.
      await this.#deps.markets.setStatus(match.id, "closed", { live: false });
      await this.#emit("match.live", {
        matchId: match.id,
        game: match.game,
        tournamentId: null,
        startedAt: new Date(this.#nowMs()).toISOString(),
      });
    } catch (error) {
      logger.warn({ err: error, matchId: match.id }, "could not close the pre-match markets");
    }

    try {
      await this.#deps.launcher.launch({
        matchId: match.id,
        game: match.game,
        seed,
        seats: match.seats.map((seat) => ({
          kind: seat.isBot ? ("bot" as const) : ("human" as const),
          playerId: seat.playerId,
          level: seat.botLevel,
        })),
        turnSeconds: this.#turnSecondsOf(match),
        allowSpectators: true,
      });
      this.#launched.add(match.id);
      logger.info({ matchId: match.id, game: match.game }, "house fixture launched");
      return true;
    } catch (error) {
      logger.error({ err: error, matchId: match.id }, "could not launch a house fixture");
      return false;
    }
  }

  /** Hands over every fixture this process launched and has since finished. */
  async #handOverLaunched(): Promise<number> {
    let handedOver = 0;
    for (const matchId of [...this.#launched]) {
      const match = await this.#deps.matches.get(matchId);
      if (match === null || (match.status !== "finished" && match.status !== "void")) {
        continue;
      }
      await this.#handOver(matchId);
      this.#launched.delete(matchId);
      this.#priced.delete(matchId);
      handedOver += 1;
    }
    return handedOver;
  }

  /**
   * Tells the rest of the server the match is over.
   *
   * The same event a room would publish: the odds engine closes the book and
   * hands the markets to settlement on it. Settlement is idempotent, so a match
   * handed over twice is settled once.
   */
  async #handOver(matchId: string): Promise<void> {
    const match = await this.#deps.matches.get(matchId);
    if (match === null) {
      return;
    }

    try {
      await this.#emit("match.finished", finishedPayload(match));
    } catch (error) {
      logger.warn({ err: error, matchId }, "could not hand a fixture to settlement");
    }
  }

  async #price(matchId: string, game: FixtureGame): Promise<FixturePriceReport> {
    if (this.#deps.price !== undefined) {
      return this.#deps.price(matchId, game);
    }
    return priceFixture(matchId, game, {
      matches: this.#deps.matches,
      markets: this.#deps.markets,
    });
  }

  async #emit<N extends FixtureEventName>(name: N, payload: EventPayloads[N]): Promise<void> {
    if (this.#deps.publish !== undefined) {
      await this.#deps.publish(name, payload);
      return;
    }
    await publish(name, payload);
  }

  #turnSecondsOf(match: MatchRecord): number {
    const stored = match.config["turnSeconds"];
    if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
      return stored;
    }
    return this.#deps.turnSeconds ?? 30;
  }

  #nowMs(): number {
    return (this.#deps.now ?? (() => new Date()))().getTime();
  }
}

/**
 * The finished-match event for a fixture.
 *
 * A Carrom result names a seat; the payload names players, and a draw has no
 * winner, so both are read from the seats rather than guessed. The reason is
 * passed through, extended union and all: the odds engine reads the id and the
 * game, and inventing a different reason would be a lie in the log.
 */
function finishedPayload(match: MatchRecord): EventPayloads["match.finished"] {
  const result = match.result;
  const winnerSeat = result?.winnerSeat ?? null;
  const winner = winnerSeat === null ? null : match.seats.find((seat) => seat.seat === winnerSeat);

  return {
    matchId: match.id,
    game: match.game,
    tournamentId: null,
    winnerPlayerId: winner?.playerId ?? null,
    loserPlayerId: loserOf(match, result, winnerSeat),
    reason: result?.reason ?? "finished",
    scores: result?.scores ?? { white: 0, black: 0 },
  };
}

/**
 * Who lost, as the event names it.
 *
 * Two seats: the other one. Four: the seat that finished last, which is the one
 * a Ludo result records in its finishing order. A draw has no loser, and a Ludo
 * finish with no order falls back to the last seat that is not the winner.
 */
function loserOf(
  match: MatchRecord,
  result: MatchResult | null,
  winnerSeat: number | null,
): string | null {
  if (result === null || winnerSeat === null) {
    return null;
  }

  const order = result.finishingOrder ?? [];
  const lastSeat = order.at(-1) ?? null;
  const seatNumber =
    lastSeat !== null && lastSeat !== winnerSeat
      ? lastSeat
      : (match.seats.find((seat) => seat.seat !== winnerSeat)?.seat ?? null);

  if (seatNumber === null) {
    return null;
  }
  return match.seats.find((seat) => seat.seat === seatNumber)?.playerId ?? null;
}
