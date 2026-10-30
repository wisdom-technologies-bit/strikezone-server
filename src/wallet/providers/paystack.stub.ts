import type {
  DepositIntent,
  DepositIntentInput,
  PaymentProvider,
  PayoutRequest,
  PayoutResult,
  WebhookVerdict,
} from "./provider.js";
import { ProviderNotConfiguredError } from "./provider.js";

/**
 * A documented stub. Deliberately not implemented.
 *
 * Real money for this product moves through the manual provider while the
 * accounting, the exposure caps and the review holds are proven. A card provider
 * adds three things that need money and a licence to test: a hosted checkout, a
 * signed webhook and transfers to a bank account. None of that is guessed at
 * here; the shape below is what a real implementation must fill in.
 *
 * To finish it:
 *
 * 1. Add PAYSTACK_SECRET_KEY and PAYSTACK_WEBHOOK_SECRET through src/lib/env.ts
 *    (never inline), and read them here.
 * 2. createDepositIntent: POST /transaction/initialize with the amount in the
 *    currency's smallest unit, our reference, and the player's email. Return the
 *    authorization_url as redirectUrl, the provider reference, credited: false.
 * 3. verifyWebhook: HMAC SHA-512 of the raw body with the webhook secret,
 *    compared in constant time against x-paystack-signature. Map charge.success
 *    to a succeeded deposit for data.reference. This file must receive the raw
 *    body: src/api/payments.ts keeps it for exactly this reason.
 * 4. createPayout: POST /transfer with a recipient created once per player
 *    (POST /transferrecipient), then reconcile transfer.success and
 *    transfer.failed webhooks before marking a withdrawal paid.
 * 5. Nothing here changes the ledger. Every provider lands in the same
 *    deposit/withdrawal rows, or it does not land at all.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack";
  readonly manual = false;

  createDepositIntent(_input: DepositIntentInput): Promise<DepositIntent> {
    return Promise.reject(
      new ProviderNotConfiguredError(this.name, "no API credentials are configured yet"),
    );
  }

  verifyWebhook(): WebhookVerdict {
    return {
      ok: false,
      reason: "not_configured",
      eventId: "",
      kind: "unknown",
      providerRef: null,
      amountMinor: null,
      status: "unknown",
    };
  }

  createPayout(_input: PayoutRequest): Promise<PayoutResult> {
    return Promise.reject(
      new ProviderNotConfiguredError(this.name, "no transfer recipient is configured yet"),
    );
  }
}
