import { z } from "zod";
import {
  type DepositIntent,
  type DepositIntentInput,
  type PaymentProvider,
  type PayoutRequest,
  type PayoutResult,
  type WebhookVerdict,
} from "./provider.js";

/**
 * The launch provider: a human moves the money.
 *
 * A deposit is credited by an admin who has seen the transfer land, and a
 * withdrawal is paid by an admin from the operator's own bank account and then
 * marked paid. Nothing is credited on trust: the deposit sits pending until a
 * human confirms it.
 */

const confirmSchema = z.strictObject({
  eventId: z.string().min(1).max(200),
  providerRef: z.string().min(1).max(200),
  amountMinor: z.number().int().positive(),
});

export class ManualProvider implements PaymentProvider {
  readonly name = "manual";
  readonly manual = true;

  #next = 1;

  createDepositIntent(_input: DepositIntentInput): Promise<DepositIntent> {
    const providerRef = `manual_ref_${String(this.#next)}`;
    this.#next += 1;
    return Promise.resolve({ provider: this.name, providerRef, credited: false });
  }

  /**
   * A manual transfer has no signed webhook. The admin confirmation route is the
   * only way in, and it does not pass through here, so any webhook claiming to
   * be manual is refused rather than trusted.
   */
  verifyWebhook(): WebhookVerdict {
    return {
      ok: false,
      reason: "manual_provider_has_no_webhook",
      eventId: "",
      kind: "unknown",
      providerRef: null,
      amountMinor: null,
      status: "unknown",
    };
  }

  createPayout(input: PayoutRequest): Promise<PayoutResult> {
    // The admin sends the money outside the system; this records the intent.
    return Promise.resolve({ providerRef: `manual_payout_${input.withdrawalId}`, paid: false });
  }

  /** Reads an admin's confirmation of an incoming transfer. */
  static readConfirmation(body: unknown): {
    eventId: string;
    providerRef: string;
    amountMinor: number;
  } {
    return confirmSchema.parse(body);
  }
}
