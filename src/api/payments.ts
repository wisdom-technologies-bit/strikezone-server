import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { PlayBlocked } from "../betting/limits.js";
import { depositRequestSchema, handlePaymentWebhook, startDeposit } from "../wallet/deposits.js";
import { paymentsRepository } from "../wallet/payments-store.js";
import {
  approveWithdrawal,
  markWithdrawalPaid,
  rejectWithdrawal,
  requestWithdrawal,
  WithdrawalRefused,
  withdrawalRequestSchema,
} from "../wallet/withdrawals.js";
import { requireUser, userOf, type VerifyUser } from "./auth.js";

/**
 * Deposits, withdrawals and the provider webhook.
 *
 * The webhook is unauthenticated by design (a provider cannot hold a session),
 * so it is verified by its own signature over the raw body and made idempotent
 * by the provider's event id. Nothing else on this router skips the user check.
 */

export interface PaymentsRouterDeps {
  readonly verifyUser?: VerifyUser;
}

const webhookParamsSchema = z.object({ provider: z.string().min(1).max(40) });
const withdrawalDecisionSchema = z.strictObject({
  action: z.enum(["approve", "paid", "reject"]),
  reason: z.string().min(1).max(200).optional(),
});

/** The raw body, kept by the JSON parser so a signature can cover it. */
export function rawBodyOf(request: { rawBody?: string }): string {
  return request.rawBody ?? "";
}

export function createPaymentsRouter(deps: PaymentsRouterDeps = {}): Router {
  const router = Router();
  const user = requireUser({ verifyUser: deps.verifyUser });

  router.post("/api/deposits", user, (request, response, next) => {
    const parsed = depositRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    const player = userOf(response);

    void (async () => {
      try {
        const started = await startDeposit(player.id, parsed.data);
        response.status(201).json({
          ok: true,
          deposit: started.deposit,
          redirectUrl: started.redirectUrl,
          credited: started.credited,
        });
      } catch (error) {
        if (error instanceof PlayBlocked) {
          response.status(409).json({ ok: false, error: error.code, ...error.details });
          return;
        }
        next(error);
      }
    })();
  });

  router.post("/api/withdrawals", user, (request, response, next) => {
    const parsed = withdrawalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    const player = userOf(response);

    void (async () => {
      try {
        const withdrawal = await requestWithdrawal(player.id, parsed.data);
        response.status(201).json({ ok: true, withdrawal });
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

  router.get("/api/withdrawals", user, (_request, response, next) => {
    const player = userOf(response);
    void (async () => {
      try {
        const withdrawals = await paymentsRepository().listWithdrawals(player.id);
        response.json({ ok: true, withdrawals });
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * The provider webhook.
   *
   * `:provider` names which provider is calling, so one route serves them all and
   * each verifies its own signature.
   */
  router.post("/api/webhooks/payments/:provider", ((request, response, next) => {
    const parsed = webhookParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "unknown_provider" });
      return;
    }

    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }

    void (async () => {
      try {
        const outcome = await handlePaymentWebhook(
          parsed.data.provider,
          headers,
          rawBodyOf(request as { rawBody?: string }),
        );
        response.status(outcome.accepted ? 200 : 400).json({ ok: outcome.accepted, ...outcome });
      } catch (error) {
        next(error);
      }
    })();
  }) satisfies RequestHandler);

  return router;
}

/** Admin-only withdrawal decisions live with the other admin money routes. */
export {
  approveWithdrawal,
  markWithdrawalPaid,
  rejectWithdrawal,
  withdrawalDecisionSchema,
};
