import { Router } from "express";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import { requireAdmin } from "./auth.js";
import { fixturesConfigFromEnv } from "../fixtures/config.js";
import { SupabaseFixturesRepository } from "../fixtures/repository.js";

/**
 * The operator's control of the house fixtures.
 *
 * Two questions and one switch. The read says what the lobby is supplied with and
 * when the next fixture starts; the switch stops or resumes *creating* fixtures.
 * Neither can touch a match already in play: a pause is about the supply, never
 * about a game someone may already have bet on.
 *
 * Every route is behind `requireAdmin`, which writes an audit row per call.
 */

const emptyBody = z.strictObject({});

/** One line of the fixture state, as an operator reads it. */
export interface FixtureControlState {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly upcoming: number;
  readonly running: number;
  readonly target: number;
  readonly maxConcurrent: number;
  readonly intervalMinutes: number;
  readonly betWindowSeconds: number;
  readonly games: readonly string[];
  readonly nextFixtureAt: string | null;
}

/** Reads the live state from the same store the scheduler reads. */
export async function fixtureControlState(
  repository: SupabaseFixturesRepository,
  config: ReturnType<typeof fixturesConfigFromEnv>,
): Promise<FixtureControlState> {
  const [paused, upcoming, running] = await Promise.all([
    repository.isPaused(),
    repository.listUpcoming(50),
    repository.listRunning(),
  ]);

  const next = upcoming
    .map((fixture) => fixture.scheduledAt)
    .filter((value): value is string => value !== null)
    .sort()[0];

  return {
    enabled: config.enabled,
    paused,
    upcoming: upcoming.length,
    running: running.length,
    target: config.target,
    maxConcurrent: config.maxConcurrent,
    intervalMinutes: config.intervalMinutes,
    betWindowSeconds: config.betWindowSeconds,
    games: config.games,
    nextFixtureAt: next ?? null,
  };
}

export function createAdminFixturesRouter(): Router {
  const router = Router();
  const repository = new SupabaseFixturesRepository();

  router.get("/api/admin/fixtures", requireAdmin, (_request, response, next) => {
    void (async () => {
      try {
        const state = await fixtureControlState(repository, fixturesConfigFromEnv());
        response.status(200).json({ ok: true, ...state });
      } catch (error) {
        next(error);
      }
    })();
  });

  for (const [action, paused] of [
    ["pause", true],
    ["resume", false],
  ] as const) {
    router.post(`/api/admin/fixtures/${action}`, requireAdmin, (request, response, next) => {
      const parsed = emptyBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        response.status(400).json({ ok: false, error: "invalid_request" });
        return;
      }

      void (async () => {
        try {
          const actor = response.locals["adminActor"];
          await repository.setPaused(
            paused,
            typeof actor === "string" ? actor : "admin",
            new Date().toISOString(),
          );
          logger.info({ paused }, "house fixtures switched");
          const state = await fixtureControlState(repository, fixturesConfigFromEnv());
          response.status(200).json({ ok: true, ...state });
        } catch (error) {
          next(error);
        }
      })();
    });
  }

  return router;
}
