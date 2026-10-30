import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../../lib/env.js";
import {
  type DepositIntent,
  type DepositIntentInput,
  type PaymentProvider,
  type PayoutRequest,
  type PayoutResult,
  type WebhookVerdict,
} from "./provider.js";

/**
 * The virtual-money provider.
 *
 * Deposits and withdrawals complete the moment they are asked for, so virtual
 * play exercises the same ledger, the same limits and the same review holds as
 * real money, with no third party in the way.
 *
 * Its webhook is signed with the same HMAC scheme a real provider would use, so
 * the webhook route is tested against a signature rather than against a stub
 * that always says yes.
 */

const webhookSchema = z.strictObject({
  eventId: z.string().min(1).max(200),
  kind: z.enum(["deposit", "withdrawal"]),
  providerRef: z.string().min(1).max(200),
  amountMinor: z.number().int().positive(),
  status: z.enum(["succeeded", "failed", "pending"]),
});

export type MockWebhook = z.infer<typeof webhookSchema>;

/** The header carrying the signature. */
export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export class MockProvider implements PaymentProvider {
  readonly name = "mock";
  readonly manual = false;

  readonly #secret: string;
  #next = 1;

  constructor(secret: string = env.RESULT_SIGNING_SECRET) {
    this.#secret = secret;
  }

  createDepositIntent(input: DepositIntentInput): Promise<DepositIntent> {
    const providerRef = `mock_dep_${String(this.#next)}`;
    this.#next += 1;
    return Promise.resolve({
      provider: this.name,
      providerRef,
      credited: true,
      ...(input.amountMinor > 0 ? {} : {}),
    });
  }

  verifyWebhook(
    headers: Readonly<Record<string, string | undefined>>,
    body: string,
  ): WebhookVerdict {
    const provided = headers[MOCK_SIGNATURE_HEADER] ?? "";
    if (!this.#signatureMatches(body, provided)) {
      return {
        ok: false,
        reason: "signature_mismatch",
        eventId: "",
        kind: "unknown",
        providerRef: null,
        amountMinor: null,
        status: "unknown",
      };
    }

    const parsed = webhookSchema.safeParse(safeJson(body));
    if (!parsed.success) {
      return {
        ok: false,
        reason: "unreadable_payload",
        eventId: "",
        kind: "unknown",
        providerRef: null,
        amountMinor: null,
        status: "unknown",
      };
    }

    return {
      ok: true,
      eventId: parsed.data.eventId,
      kind: parsed.data.kind,
      providerRef: parsed.data.providerRef,
      amountMinor: parsed.data.amountMinor,
      status: parsed.data.status,
    };
  }

  createPayout(input: PayoutRequest): Promise<PayoutResult> {
    return Promise.resolve({ providerRef: `mock_payout_${input.withdrawalId}`, paid: true });
  }

  /** Signs a body the way the route expects, so tests and tools can send one. */
  sign(body: string): string {
    return createHmac("sha256", this.#secret).update(body).digest("hex");
  }

  #signatureMatches(body: string, provided: string): boolean {
    const expected = Buffer.from(this.sign(body), "utf8");
    const actual = Buffer.from(provided, "utf8");
    if (expected.length !== actual.length || actual.length === 0) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}
