import { Router } from "express";
import { matchMaker } from "colyseus";
import { z } from "zod";
import { BOT_LEVELS } from "../engines/carrom/bot-config.js";
import { resolveConfig } from "../engines/carrom/config.js";
import { LUDO_BOT_POLICIES, resolveLudoConfig } from "../engines/ludo/index.js";
import { commitOf, createMatchSeed } from "../lib/fair-rng.js";
import { isShuttingDown } from "../lib/lifecycle.js";
import { logger } from "../lib/logger.js";
import { matchRepository } from "../lib/match-store.js";

/**
 * POST /dev/start-match
 *
 * Starts a match between two bots and opens its room, so the whole pipeline can be
 * exercised locally without two browsers: create the match, commit to a seed nice
 * and early, create the room with that seed, and hand back the room id to join.
 *
 * Mounted only while NODE_ENV is development (see src/app.ts). It costs nothing to
 * run and it touches no money.
 */

const botSeatSchema = z.strictObject({ bot: z.enum(BOT_LEVELS) });

/** The body, with a sensible default: a Master against a Club. */
export const startMatchSchema = z
  .object({
    white: botSeatSchema.default({ bot: "master" }),
    black: botSeatSchema.default({ bot: "club" }),
    turnSeconds: z.number().int().min(5).max(300).default(30),
    allowSpectators: z.boolean().default(true),
  })
  .strict();

export type StartMatchBody = z.infer<typeof startMatchSchema>;

/** The policies a dev Ludo match may seat. */
const LUDO_POLICY_IDS = LUDO_BOT_POLICIES.map((policy) => policy.id);

/**
 * POST /dev/start-ludo
 *
 * The same convenience for Ludo: a four bot match with the published policies,
 * opened, with the room id handed back for /dev/ludo.html to watch.
 */
export const startLudoSchema = z
  .object({
    policies: z.array(z.enum(LUDO_POLICY_IDS)).length(4).default([
      "cautious",
      "aggressive",
      "racer",
      "cautious",
    ]),
    allowSpectators: z.boolean().default(true),
  })
  .strict();

export type StartLudoBody = z.infer<typeof startLudoSchema>;

/** How a room is created. Injectable so the endpoint can be tested without a server. */
export type CreateRoom = (
  roomName: string,
  options: Record<string, unknown>,
) => Promise<{ roomId: string }>;

export interface DevRouterOptions {
  readonly createRoom?: CreateRoom;
}

const defaultCreateRoom: CreateRoom = async (roomName, options) => {
  const created = await matchMaker.createRoom(roomName, options);
  return { roomId: created.roomId };
};

export function createDevRouter(options: DevRouterOptions = {}): Router {
  const createRoom = options.createRoom ?? defaultCreateRoom;
  const router: Router = Router();

  router.post("/dev/start-match", async (request, response, next) => {
    const parsed = startMatchSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      response.status(400).json({
        ok: false,
        error: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    if (isShuttingDown()) {
      response.status(503).json({ ok: false, error: "shutting_down" });
      return;
    }

    const body = parsed.data;

    try {
      const seed = createMatchSeed();
      const seedCommit = commitOf(seed);
      const carrom = resolveConfig();

      const match = await matchRepository().create({
        seedCommit,
        config: { carrom, turnSeconds: body.turnSeconds },
        seats: [
          { seat: 1, botLevel: body.white.bot },
          { seat: 2, botLevel: body.black.bot },
        ],
      });

      const { roomId } = await createRoom("carrom", {
        matchId: match.id,
        seed,
        seats: [
          { kind: "bot", level: body.white.bot },
          { kind: "bot", level: body.black.bot },
        ],
        turnSeconds: body.turnSeconds,
        allowSpectators: body.allowSpectators,
      });

      logger.info({ matchId: match.id, roomId }, "dev match started");

      response.status(201).json({
        ok: true,
        matchId: match.id,
        roomId,
        seedCommit,
        turnSeconds: body.turnSeconds,
        seats: match.seats.map((seat) => ({
          seat: seat.seat,
          playerId: seat.playerId,
          displayName: seat.displayName,
          isBot: seat.isBot,
          botPolicy: seat.botPolicy,
        })),
        watch: `npm run carrom:watch -- ${roomId}`,
        verify: `npm run verify-match -- ${match.id}`,
      });
    } catch (error) {
      logger.error({ err: error }, "could not start a dev match");
      next(error);
    }
  });

  router.post("/dev/start-ludo", async (request, response, next) => {
    const parsed = startLudoSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      response.status(400).json({
        ok: false,
        error: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    if (isShuttingDown()) {
      response.status(503).json({ ok: false, error: "shutting_down" });
      return;
    }

    const body = parsed.data;

    try {
      const seed = createMatchSeed();
      const seedCommit = commitOf(seed);
      const ludo = resolveLudoConfig({ players: 4 });

      const match = await matchRepository().create({
        game: "ludo",
        seedCommit,
        config: { ludo },
        seats: body.policies.map((policy, index) => ({
          seat: (index + 1) as 1 | 2 | 3 | 4,
          botLevel: "club" as const,
          botPolicy: policy,
        })),
      });

      const { roomId } = await createRoom("ludo", {
        matchId: match.id,
        seed,
        allowSpectators: body.allowSpectators,
      });

      logger.info({ matchId: match.id, roomId }, "dev ludo match started");

      response.status(201).json({
        ok: true,
        matchId: match.id,
        roomId,
        seedCommit,
        seats: match.seats.map((seat) => ({
          seat: seat.seat,
          playerId: seat.playerId,
          displayName: seat.displayName,
          isBot: seat.isBot,
          botPolicy: seat.botPolicy,
        })),
        watch: "/dev/ludo.html",
        verify: `npm run verify-match -- ${match.id}`,
      });
    } catch (error) {
      logger.error({ err: error }, "could not start a dev ludo match");
      next(error);
    }
  });

  return router;
}
