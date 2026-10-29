import { Router } from "express";
import { z } from "zod";
import type { TournamentRepository } from "../tournaments/repository.js";
import { tournamentRepository } from "../tournaments/repository.js";
import {
  createTournamentSchema,
  TournamentError,
  type TournamentService,
} from "../tournaments/service.js";
import { tournamentService } from "../tournaments/index.js";
import { publicTournament, sendServiceError } from "./tournaments.js";
import { requireAdmin } from "./auth.js";

/**
 * The operator's controls, behind `x-admin-key`.
 *
 * Create a tournament, open it, cancel it, and force a bracket decision. There is
 * deliberately no endpoint here that pays money by hand: prizes are paid by the
 * service when the format says the tournament is decided, and a refund is issued
 * by cancelling.
 */

const idSchema = z.string().min(1).max(64);

const cancelBodySchema = z
  .strictObject({ reason: z.string().min(3).max(200).default("cancelled by an operator") })
  .strict();

const forceAdvanceBodySchema = z
  .strictObject({
    positionId: z.string().min(1).max(64),
    winnerPlayerId: z.string().min(1).max(64),
  })
  .strict();

/** The router's dependencies. */
export interface AdminTournamentRouterDeps {
  readonly service?: TournamentService;
  readonly repository?: TournamentRepository;
}

/** The admin routes. */
export function createAdminTournamentsRouter(deps: AdminTournamentRouterDeps = {}): Router {
  const router: Router = Router();
  const resolveService = (): TournamentService => deps.service ?? tournamentService();
  const resolveRepository = (): TournamentRepository => deps.repository ?? tournamentRepository();

  const invalid = (
    response: { status(code: number): { json(body: unknown): void } },
    issues: readonly { path: readonly (string | number | symbol)[]; message: string }[],
  ): void => {
    response.status(400).json({
      ok: false,
      error: "invalid_request",
      issues: issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  };

  const handle = <T>(
    promise: Promise<T>,
    response: { status(code: number): { json(body: unknown): void } },
    next: (error?: unknown) => void,
    onSuccess: (value: T) => void,
  ): void => {
    promise.then(onSuccess).catch((error: unknown) => {
      if (error instanceof TournamentError) {
        sendServiceError(response, error);
        return;
      }
      next(error);
    });
  };

  router.post("/api/admin/tournaments", requireAdmin, (request, response, next) => {
    const parsed = createTournamentSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      invalid(response, parsed.error.issues);
      return;
    }

    handle(resolveService().create(parsed.data), response, next, (created) => {
      response.status(201).json({ ok: true, tournament: publicTournament(created as never) });
    });
  });

  router.post("/api/admin/tournaments/:id/open", requireAdmin, (request, response, next) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    handle(resolveService().open(id.data), response, next, (opened) => {
      response.status(200).json({ ok: true, tournament: publicTournament(opened as never) });
    });
  });

  router.post("/api/admin/tournaments/:id/cancel", requireAdmin, (request, response, next) => {
    const id = idSchema.safeParse(request.params.id);
    const body = cancelBodySchema.safeParse(request.body ?? {});
    if (!id.success || !body.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    handle(resolveService().cancel(id.data, body.data.reason), response, next, (result) => {
      response.status(200).json({ ok: true, ...(result as object) });
    });
  });

  router.post(
    "/api/admin/tournaments/:id/force-advance",
    requireAdmin,
    (request, response, next) => {
      const id = idSchema.safeParse(request.params.id);
      const body = forceAdvanceBodySchema.safeParse(request.body ?? {});
      if (!id.success || !body.success) {
        response.status(400).json({ ok: false, error: "invalid_request" });
        return;
      }

      handle(
        resolveService().forceAdvance({
          tournamentId: id.data,
          positionId: body.data.positionId,
          winnerPlayerId: body.data.winnerPlayerId,
        }),
        response,
        next,
        () => {
          const repository = resolveRepository();
          void repository
            .listPositions(id.data)
            .then((positions) => {
              response.status(200).json({
                ok: true,
                positions: positions.map((position) => ({
                  id: position.id,
                  round: position.round,
                  slot: position.slot,
                  status: position.status,
                  winnerPlayerId: position.winnerPlayerId,
                  isWalkover: position.isWalkover,
                })),
              });
            })
            .catch(next);
        },
      );
    },
  );

  return router;
}
