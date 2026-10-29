import { Router } from "express";
import { z } from "zod";
import { verifyLogChain } from "../lib/match-log.js";
import { matchRepository } from "../lib/match-store.js";

/**
 * GET /api/matches/:id/replay
 *
 * The public record of a match: its seats, its hash-chained events, and its
 * result once it has one. The seed is revealed here only after the match is
 * finished, which is the whole point of committing to it beforehand: while play is
 * live the commitment is public and the seed is not.
 */
export const matchesRouter: Router = Router();

const replayParamsSchema = z.strictObject({ id: z.string().min(1).max(64) });

matchesRouter.get("/api/matches/:id/replay", async (request, response, next) => {
  const params = replayParamsSchema.safeParse(request.params);
  if (!params.success) {
    response.status(400).json({ ok: false, error: "invalid_match_id" });
    return;
  }

  try {
    const matchId = params.data.id;
    const repository = matchRepository();
    const match = await repository.get(matchId);

    if (match === null) {
      response.status(404).json({ ok: false, error: "not_found" });
      return;
    }

    const events = await repository.listEvents(matchId);
    const chain = verifyLogChain(events, match.seedCommit ?? undefined);
    const finished = match.status === "finished";

    response.status(200).json({
      ok: true,
      match: {
        id: match.id,
        game: match.game,
        status: match.status,
        seedCommit: match.seedCommit,
        // Only after the match has finished, and only if one was recorded.
        seedReveal: finished ? match.seedReveal : null,
        logHeadHash: match.logHeadHash,
        result: match.result,
        resultSignature: match.resultSignature,
        startedAt: match.startedAt,
        endedAt: match.endedAt,
        seats: match.seats.map((seat) => ({
          seat: seat.seat,
          playerId: seat.playerId,
          displayName: seat.displayName,
          isBot: seat.isBot,
          botPolicy: seat.botPolicy,
        })),
      },
      events,
      verification: {
        chainOk: chain.ok,
        head: chain.ok ? chain.head : null,
        reason: chain.ok ? null : chain.reason,
        seq: chain.ok ? null : chain.seq,
      },
    });
  } catch (error) {
    next(error);
  }
});
