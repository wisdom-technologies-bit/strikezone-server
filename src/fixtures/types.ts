import type { BotLevel } from "../engines/carrom/bot-config.js";

/**
 * House fixtures: the bot matches that keep the lobby something to bet on.
 *
 * A fixture is an ordinary match row. Nothing about it is special downstream:
 * the same repository creates it, the same room plays it, the same pricer prices
 * it and the same settlement pays it. What the fixtures layer adds is a rolling
 * supply of them and the lifecycle around the start time.
 */

export type FixtureGame = "carrom" | "ludo";

/** One seat of a fixture, as the match row will record it. */
export interface FixtureSeatPlan {
  readonly seat: 1 | 2 | 3 | 4;
  /** The Carrom skill tier. Every bot has one, for the players table. */
  readonly botLevel: BotLevel;
  /** The Ludo policy id (cautious, aggressive, racer). Absent for Carrom. */
  readonly botPolicy?: string;
  /** A stable bot identity: the players table keys a bot on its display name. */
  readonly displayName: string;
}

/** Everything needed to create one fixture. */
export interface FixturePlan {
  readonly game: FixtureGame;
  readonly seats: readonly FixtureSeatPlan[];
  readonly config: Readonly<Record<string, unknown>>;
}

/** The validated fixture settings the scheduler runs on. */
export interface FixturesConfig {
  readonly enabled: boolean;
  readonly target: number;
  readonly intervalMinutes: number;
  readonly betWindowSeconds: number;
  readonly maxConcurrent: number;
  readonly games: readonly FixtureGame[];
}

/** What one scheduler tick did, for logs and tests. */
export interface FixtureTickReport {
  /** True when the tick did nothing because it was disabled or another held the lease. */
  readonly skipped: boolean;
  /** Fixtures created (and priced) this tick. */
  readonly created: number;
  /** Fixtures whose room was launched this tick. */
  readonly started: number;
  /** Fixtures noticed as live and left alone, because the cap was reached. */
  readonly delayed: number;
  /** Finished fixtures handed to settlement this tick. */
  readonly settled: number;
  /** Fixtures priced this tick, including ones created earlier that had no price. */
  readonly priced: number;
}

/** A scheduled fixture, as the scheduler reads it back from storage. */
export interface StoredFixture {
  readonly id: string;
  readonly game: FixtureGame;
  readonly status: "scheduled" | "live" | "finished" | "void";
  readonly scheduledAt: string | null;
  readonly seedCommit: string | null;
  readonly startedAt: string | null;
}
