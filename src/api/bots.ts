import { Router } from "express";
import { publishedBots } from "../engines/carrom/bots.js";

/**
 * GET /api/bots
 *
 * The bot catalogue: every published level, its display name, its policy id and
 * the exact numbers it plays with. A bot is published as a bot (`isBot: true`),
 * so no client has to guess, and none can present one as a person.
 */
export const botsRouter: Router = Router();

botsRouter.get("/api/bots", (_request, response) => {
  response.status(200).json({ ok: true, bots: publishedBots() });
});
