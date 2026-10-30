import { Router } from "express";
import { placeBet, placeBetRequestSchema, toBetView } from "../betting/place.js";
import { betsRepository } from "../betting/bets-store-store.js";
import { BetRejected } from "../betting/errors.js";
import {
  limitsRepository,
  limitsRequestSchema,
  selfExclude,
  selfExclusionRequestSchema,
  updateLimits,
  PlayBlocked,
} from "../betting/limits.js";
import { requireUser, userOf } from "./auth.js";
import type { VerifyUser } from "./auth.js";

/**
 * Player money routes: placing a bet, and the responsible-play controls.
 *
 * Every body is parsed with a strict schema, so an unknown field is a refused
 * request rather than a silently ignored one.
 */

export interface BetsRouterDeps {
  readonly verifyUser?: VerifyUser;
}

export function createBetsRouter(deps: BetsRouterDeps = {}): Router {
  const router = Router();

  router.post(
    "/api/bets",
    requireUser({ verifyUser: deps.verifyUser }),
    (request, response, next) => {
      const parsed = placeBetRequestSchema.safeParse(request.body);
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

      const user = userOf(response);

      void (async () => {
        try {
          const placed = await placeBet(user.id, parsed.data);
          response.status(201).json({
            ok: true,
            bet: toBetView(placed),
            replayed: placed.replayed,
            balanceMinor: placed.balanceMinor,
          });
        } catch (error) {
          if (error instanceof BetRejected) {
            response.status(error.status).json({ ok: false, error: error.code, ...error.details });
            return;
          }
          next(error);
        }
      })();
    },
  );

  router.post(
    "/api/me/self-exclude",
    requireUser({ verifyUser: deps.verifyUser }),
    (request, response, next) => {
      const parsed = selfExclusionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ ok: false, error: "invalid_request" });
        return;
      }

      const user = userOf(response);

      void (async () => {
        try {
          const result = await selfExclude(user.id, parsed.data, limitsRepository());
          response.json({ ok: true, ...result });
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.get(
    "/api/me/limits",
    requireUser({ verifyUser: deps.verifyUser }),
    (_request, response, next) => {
      const user = userOf(response);
      void (async () => {
        try {
          const row = await limitsRepository().getLimits(user.id);
          response.json({ ok: true, limits: row.limits, pending: row.pending });
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.put(
    "/api/me/limits",
    requireUser({ verifyUser: deps.verifyUser }),
    (request, response, next) => {
      const parsed = limitsRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({
          ok: false,
          error: "invalid_request",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
        return;
      }

      const user = userOf(response);

      void (async () => {
        try {
          const result = await updateLimits(user.id, parsed.data, limitsRepository());
          response.json({ ok: true, ...result });
        } catch (error) {
          if (error instanceof PlayBlocked) {
            response.status(409).json({ ok: false, error: error.code, ...error.details });
            return;
          }
          next(error);
        }
      })();
    },
  );

  /** A player's own bets, newest first. */
  router.get(
    "/api/me/bets",
    requireUser({ verifyUser: deps.verifyUser }),
    (_request, response, next) => {
      const user = userOf(response);
      void (async () => {
        try {
          const bets = await betsRepository().listForPlayer(user.id);
          response.json({ ok: true, bets });
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  return router;
}
