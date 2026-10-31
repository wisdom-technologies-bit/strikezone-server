import { env } from "../lib/env.js";
import type { FixtureGame, FixturesConfig } from "./types.js";

/**
 * The fixture settings, read from the validated environment.
 *
 * Everything with a default is a tunable an operator may ignore; the only switch
 * that changes behaviour on its own is FIXTURES_ENABLED, and it is off.
 */
export function fixturesConfigFromEnv(): FixturesConfig {
  return {
    enabled: env.FIXTURES_ENABLED,
    target: env.UPCOMING_FIXTURES_TARGET,
    intervalMinutes: env.FIXTURE_INTERVAL_MINUTES,
    betWindowSeconds: env.BET_WINDOW_SECONDS,
    maxConcurrent: env.MAX_CONCURRENT_HOUSE_MATCHES,
    games: env.FIXTURE_GAMES as readonly FixtureGame[],
  };
}
