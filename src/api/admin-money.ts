import { Router } from "express";
import { z } from "zod";
import {
  bettingPaused,
  pauseBetting,
  reconcile,
  recordSnapshot,
  snapshotRequestSchema,
  solvency,
  topUpBankroll,
  topUpRequestSchema,
} from "../admin/bankroll.js";
import { approvePayout, PayoutRefused, rejectPayout } from "../admin/payouts.js";
import { adminStore } from "../admin/store.js";
import { betsRepository } from "../betting/bets-store-store.js";
import { marketsRepository } from "../odds/markets-store.js";
import {
  approveWithdrawal,
  markWithdrawalPaid,
  rejectWithdrawal,
  WithdrawalRefused,
} from "../wallet/withdrawals.js";
import { requireAdmin } from "./auth.js";

/**
 * The operator's money API. Every route needs `x-admin-key`, and every route that
 * changes something writes an audit row before it reports success.
 */

const idSchema = z.object({ id: z.string().min(1).max(64) });
const reasonSchema = z.strictObject({ reason: z.string().min(1).max(200) });
const pauseSchema = z.strictObject({ paused: z.boolean(), note: z.string().max(200).optional() });

export function createAdminMoneyRouter(): Router {
  const router = Router();
  const admin = requireAdmin;

  /** The operator names themselves; the key is shared, the note says who. */
  const actorOf = (request: { headers: Record<string, unknown> }): string => {
    const given = request.headers["x-admin-actor"];
    const actor = Array.isArray(given) ? given[0] : given;
    return typeof actor === "string" && actor.trim() !== "" ? actor.trim() : "admin";
  };

  router.post("/api/admin/bankroll/topup", admin, (request, response, next) => {
    const parsed = topUpRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    void (async () => {
      try {
        const result = await topUpBankroll(parsed.data, actorOf(request));
        const numbers = await solvency();
        response.status(201).json({ ok: true, ...result, houseMinor: numbers.houseMinor });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get("/api/admin/solvency", admin, (_request, response, next) => {
    void (async () => {
      try {
        response.json({ ok: true, ...(await solvency()) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post("/api/admin/solvency/snapshot", admin, (request, response, next) => {
    const parsed = snapshotRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    void (async () => {
      try {
        const result = await recordSnapshot(parsed.data, actorOf(request));
        response.status(201).json({ ok: true, ...result });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get("/api/admin/reconcile", admin, (_request, response, next) => {
    void (async () => {
      try {
        response.json({ ok: true, ...(await reconcile()) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get("/api/admin/bets/pending-review", admin, (_request, response, next) => {
    void (async () => {
      try {
        const bets = await betsRepository().listPendingReview();
        response.json({ ok: true, bets });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post("/api/admin/bets/:id/approve", admin, (request, response, next) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    void (async () => {
      try {
        const bet = await approvePayout(parsed.data.id, actorOf(request));
        response.json({ ok: true, bet });
      } catch (error) {
        if (error instanceof PayoutRefused) {
          response.status(error.code === "not_found" ? 404 : 409).json({
            ok: false,
            error: error.code,
            message: error.message,
          });
          return;
        }
        next(error);
      }
    })();
  });

  router.post("/api/admin/bets/:id/reject", admin, (request, response, next) => {
    const params = idSchema.safeParse(request.params);
    const body = reasonSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    void (async () => {
      try {
        const bet = await rejectPayout(params.data.id, actorOf(request), body.data.reason);
        response.json({ ok: true, bet });
      } catch (error) {
        if (error instanceof PayoutRefused) {
          response.status(error.code === "not_found" ? 404 : 409).json({
            ok: false,
            error: error.code,
            message: error.message,
          });
          return;
        }
        next(error);
      }
    })();
  });

  /** Withdrawals: approve, mark paid, or reject. */
  router.post("/api/admin/withdrawals/:id/approve", admin, (request, response, next) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    void (async () => {
      try {
        const withdrawal = await approveWithdrawal(parsed.data.id, actorOf(request));
        response.json({ ok: true, withdrawal });
      } catch (error) {
        if (error instanceof WithdrawalRefused) {
          response.status(error.code === "not_found" ? 404 : 409).json({
            ok: false,
            error: error.code,
            message: error.message,
          });
          return;
        }
        next(error);
      }
    })();
  });

  router.post("/api/admin/withdrawals/:id/paid", admin, (request, response, next) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    void (async () => {
      try {
        const withdrawal = await markWithdrawalPaid(parsed.data.id, actorOf(request));
        response.json({ ok: true, withdrawal });
      } catch (error) {
        if (error instanceof WithdrawalRefused) {
          response.status(error.code === "not_found" ? 404 : 409).json({
            ok: false,
            error: error.code,
            message: error.message,
          });
          return;
        }
        next(error);
      }
    })();
  });

  router.post("/api/admin/withdrawals/:id/reject", admin, (request, response, next) => {
    const params = idSchema.safeParse(request.params);
    const body = reasonSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    void (async () => {
      try {
        const withdrawal = await rejectWithdrawal(
          params.data.id,
          actorOf(request),
          body.data.reason,
        );
        response.json({ ok: true, withdrawal });
      } catch (error) {
        if (error instanceof WithdrawalRefused) {
          response.status(error.code === "not_found" ? 404 : 409).json({
            ok: false,
            error: error.code,
            message: error.message,
          });
          return;
        }
        next(error);
      }
    })();
  });

  /** The global betting switch. */
  router.get("/api/admin/betting", admin, (_request, response, next) => {
    void (async () => {
      try {
        response.json({ ok: true, paused: await bettingPaused() });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post("/api/admin/betting/pause", admin, (request, response, next) => {
    const parsed = pauseSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    void (async () => {
      try {
        const result = await pauseBetting(parsed.data.paused, actorOf(request));
        response.json({ ok: true, ...result });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** The per-market switch: suspends or reopens one selection. */
  router.post("/api/admin/markets/:id/suspend", admin, (request, response, next) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    const body = z
      .strictObject({ suspended: z.boolean().default(true) })
      .safeParse(request.body ?? {});
    if (!body.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        const found = await marketsRepository().setSelectionStatus(
          parsed.data.id,
          body.data.suspended ? "suspended" : "open",
        );
        if (!found) {
          response.status(404).json({ ok: false, error: "market_not_found" });
          return;
        }
        await adminStore().recordAction({
          action: body.data.suspended ? "market_suspended" : "market_reopened",
          targetType: "market",
          targetId: parsed.data.id,
          payload: { suspended: body.data.suspended },
          actor: actorOf(request),
          at: new Date().toISOString(),
        });
        response.json({ ok: true, marketId: parsed.data.id, suspended: body.data.suspended });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** The audit trail, newest first. */
  router.get("/api/admin/audit", admin, (request, response, next) => {
    const limit = Number(request.query["limit"] ?? 50);
    void (async () => {
      try {
        const actions = await adminStore().listActions(
          Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50,
        );
        response.json({ ok: true, actions });
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
