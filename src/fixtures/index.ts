import { env } from "../lib/env.js";
import { matchRepository } from "../lib/match-store.js";
import { marketsRepository } from "../odds/markets-store.js";
import { colyseusLauncher } from "../tournaments/launcher.js";
import { SupabaseSchedulerLease } from "../tournaments/scheduler.js";
import { fixturesConfigFromEnv } from "./config.js";
import { SupabaseFixturesRepository } from "./repository.js";
import {
  FIXTURE_LEASE_LOCK_KEY,
  FIXTURE_LEASE_NAME,
  HouseFixturesScheduler,
  type FixtureLease,
} from "./scheduler.js";

/**
 * Wiring, in one place, as the tournaments do it.
 *
 * The scheduler takes its collaborators as arguments so a test can give it a
 * clock, a launcher and in-memory stores; production asks for the composed one.
 */

let scheduler: HouseFixturesScheduler | null = null;

/** The scheduler the process runs. */
export function houseFixturesScheduler(): HouseFixturesScheduler {
  scheduler ??= createHouseFixturesScheduler();
  return scheduler;
}

export function createHouseFixturesScheduler(options?: {
  readonly lease?: FixtureLease;
}): HouseFixturesScheduler {
  return new HouseFixturesScheduler({
    config: fixturesConfigFromEnv(),
    repository: new SupabaseFixturesRepository(),
    matches: matchRepository(),
    markets: marketsRepository(),
    launcher: colyseusLauncher,
    lease:
      options?.lease ??
      new SupabaseSchedulerLease({
        name: FIXTURE_LEASE_NAME,
        lockKey: FIXTURE_LEASE_LOCK_KEY,
      }),
    secret: env.RESULT_SIGNING_SECRET,
  });
}

/** Drops the composed scheduler, so the next call rebuilds it. */
export function resetHouseFixturesScheduler(): void {
  scheduler?.stop();
  scheduler = null;
}

export { HouseFixturesScheduler, InMemoryFixtureLease } from "./scheduler.js";
export { SupabaseFixturesRepository, InMemoryFixturesRepository } from "./repository.js";
export { fixturesConfigFromEnv } from "./config.js";
export { fixturePlanFor, LUDO_HOUSE_BOTS } from "./roster.js";
export { fixtureSeed, fixtureSeedCommit } from "./seed.js";
export { priceFixture } from "./pricing.js";
export type { FixturesConfig, FixtureTickReport, FixtureGame, StoredFixture } from "./types.js";
export type { FixturesRepository } from "./repository.js";
