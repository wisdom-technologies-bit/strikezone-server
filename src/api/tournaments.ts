import { Router } from "express";
import { z } from "zod";
import { formatFor } from "../tournaments/format.js";
import type { TournamentRepository } from "../tournaments/repository.js";
import { tournamentRepository } from "../tournaments/repository.js";
import type { TournamentService } from "../tournaments/service.js";
import { TournamentError } from "../tournaments/service.js";
import { tournamentService } from "../tournaments/index.js";
import { TOURNAMENT_GAMES, TOURNAMENT_STATUSES } from "../tournaments/types.js";
import type { BracketPositionRecord, EntryRecord, TournamentRecord } from "../tournaments/types.js";
import { requireUser, userOf, type VerifyUser } from "./auth.js";

/**
 * The tournament API.
 *
 * Public reads, a player's own registration, and the operator's controls in
 * `admin-tournaments.ts`. Every body and query string is parsed with zod before
 * it is used, and every refusal carries a code the client can act on.
 */

const listQuerySchema = z
  .strictObject({
    status: z.enum(TOURNAMENT_STATUSES).optional(),
    game: z.enum(TOURNAMENT_GAMES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const idSchema = z.string().min(1).max(64);

const emptyBodySchema = z.strictObject({});

/** Maps a service refusal onto a status code. */
export function statusForError(error: TournamentError): number {
  switch (error.code) {
    case "not_found":
      return 404;
    case "invalid":
      return 400;
    case "insufficient_funds":
      return 402;
    default:
      return 409;
  }
}

/** Sends an error response for anything the service can throw. */
export function sendServiceError(
  response: {
    status(code: number): { json(body: unknown): void };
  },
  error: unknown,
): void {
  if (error instanceof TournamentError) {
    response.status(statusForError(error)).json({
      ok: false,
      error: error.code,
      message: error.message,
    });
    return;
  }
  throw error;
}

/** The public view of a tournament: what anyone may see. */
export function publicTournament(tournament: TournamentRecord): Record<string, unknown> {
  return {
    id: tournament.id,
    name: tournament.name,
    game: tournament.game,
    format: tournament.format,
    status: tournament.status,
    entryFeeMinor: tournament.entryFeeMinor,
    prizePoolMinor: tournament.prizePoolMinor,
    currency: tournament.currency,
    minPlayers: tournament.minPlayers,
    maxPlayers: tournament.maxPlayers,
    registrationOpensAt: tournament.registrationOpensAt,
    registrationClosesAt: tournament.registrationClosesAt,
    startsAt: tournament.startsAt,
    championPlayerId: tournament.championPlayerId,
    payouts: tournament.payouts,
    finishedAt: tournament.finishedAt,
    cancelledAt: tournament.cancelledAt,
    createdAt: tournament.createdAt,
    rules: {
      rakeBps: tournament.config.rakeBps,
      prizeSplit: tournament.config.prizeSplit,
      botPrizePolicy: tournament.config.botPrizePolicy,
      fillWithBots: tournament.config.fillWithBots,
      match: tournament.config.match,
      walkoverSeconds: tournament.config.walkoverSeconds,
    },
  };
}

/** One seat of a bracket position, with the name to show. */
function seatView(
  playerId: string | null,
  entries: ReadonlyMap<string, EntryRecord>,
): Record<string, unknown> | null {
  if (playerId === null) {
    return null;
  }
  const entry = entries.get(playerId);
  return {
    playerId,
    displayName: entry?.displayName ?? playerId,
    isBot: entry?.isBot ?? false,
    seed: entry?.seed ?? null,
  };
}

/** One bracket position, with its status. */
function positionView(
  position: BracketPositionRecord,
  entries: ReadonlyMap<string, EntryRecord>,
): Record<string, unknown> {
  return {
    id: position.id,
    round: position.round,
    slot: position.slot,
    status: position.status,
    dueAt: position.dueAt,
    matchId: position.matchId,
    isWalkover: position.isWalkover,
    points: position.points,
    seat1: seatView(position.seat1PlayerId, entries),
    seat2: seatView(position.seat2PlayerId, entries),
    winner: seatView(position.winnerPlayerId, entries),
    loser: seatView(position.loserPlayerId, entries),
    winnerToSlot: position.winnerToSlot,
  };
}

/** The routers' dependencies. */
export interface TournamentRouterDeps {
  readonly service?: TournamentService;
  readonly repository?: TournamentRepository;
  readonly verifyUser?: VerifyUser;
}

/** The public and player routes. */
export function createTournamentsRouter(deps: TournamentRouterDeps = {}): Router {
  const router: Router = Router();
  const resolveService = (): TournamentService => deps.service ?? tournamentService();
  const resolveRepository = (): TournamentRepository => deps.repository ?? tournamentRepository();

  router.get("/api/tournaments", (request, response, next) => {
    const parsed = listQuerySchema.safeParse(request.query);
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

    const query = parsed.data;

    resolveRepository()
      .list({
        status: query.status === undefined ? undefined : [query.status],
        game: query.game,
        limit: query.limit,
      })
      .then((listed) => {
        response.status(200).json({ ok: true, tournaments: listed.map(publicTournament) });
      })
      .catch(next);
  });

  router.get("/api/tournaments/:id", (request, response, next) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    const repository = resolveRepository();

    Promise.all([repository.get(id.data), repository.listEntries(id.data)])
      .then(([tournament, entries]) => {
        if (tournament === null) {
          response.status(404).json({ ok: false, error: "not_found" });
          return;
        }

        return repository.listPositions(tournament.id).then((positions) => {
          const byId = new Map(entries.map((entry) => [entry.playerId, entry]));
          const format = formatFor(tournament.format);
          const plan = format.plan(Math.max(entries.length, 2));

          response.status(200).json({
            ok: true,
            tournament: publicTournament(tournament),
            bracket: {
              rounds: plan.rounds,
              byes: plan.byes,
              positions: positions.map((position) => positionView(position, byId)),
            },
            entries: entries.map((entry) => ({
              playerId: entry.playerId,
              displayName: entry.displayName,
              isBot: entry.isBot,
              seed: entry.seed,
              status: entry.status,
              eliminatedRound: entry.eliminatedRound,
            })),
          });
        });
      })
      .catch(next);
  });

  router.post(
    "/api/tournaments/:id/register",
    requireUser({ verifyUser: deps.verifyUser }),
    (request, response, next) => {
      const id = idSchema.safeParse(request.params.id);
      const body = emptyBodySchema.safeParse(request.body ?? {});
      if (!id.success || !body.success) {
        response.status(400).json({ ok: false, error: "invalid_request" });
        return;
      }

      const user = userOf(response);

      resolveService()
        .register({ tournamentId: id.data, profileId: user.id, displayName: user.displayName })
        .then((entry) => {
          response.status(201).json({
            ok: true,
            entry: {
              playerId: entry.playerId,
              displayName: entry.displayName,
              status: entry.status,
              entryFeeMinor: entry.entryFeeMinor,
            },
          });
        })
        .catch((error: unknown) => {
          if (error instanceof TournamentError) {
            sendServiceError(response, error);
            return;
          }
          next(error);
        });
    },
  );

  router.post(
    "/api/tournaments/:id/withdraw",
    requireUser({ verifyUser: deps.verifyUser }),
    (request, response, next) => {
      const id = idSchema.safeParse(request.params.id);
      const body = emptyBodySchema.safeParse(request.body ?? {});
      if (!id.success || !body.success) {
        response.status(400).json({ ok: false, error: "invalid_request" });
        return;
      }

      const user = userOf(response);

      resolveService()
        .withdraw({ tournamentId: id.data, profileId: user.id })
        .then(() => {
          response.status(200).json({ ok: true, withdrawn: true });
        })
        .catch((error: unknown) => {
          if (error instanceof TournamentError) {
            sendServiceError(response, error);
            return;
          }
          next(error);
        });
    },
  );

  return router;
}
