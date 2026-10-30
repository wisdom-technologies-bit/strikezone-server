/**
 * The seam between this system and whoever moves real money.
 *
 * Three operations are enough for both ends of a payment: ask for a deposit,
 * understand a webhook, and pay a withdrawal. Everything else (limits, ledger,
 * idempotency, review) stays inside the system, so adding a provider never
 * changes an accounting rule.
 */

/** A deposit the player has been asked to make. */
export interface DepositIntent {
  readonly provider: string;
  /** The provider's reference. Unique per provider; the crediting key. */
  readonly providerRef: string;
  /** True when the money is already in: a mock does this, a real provider never. */
  readonly credited: boolean;
  /** Where to send the player, when the provider hosts a checkout page. */
  readonly redirectUrl?: string;
}

export interface DepositIntentInput {
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Our own reference, so a provider can echo it back. */
  readonly reference: string;
}

/** What a webhook turned out to mean. */
export interface WebhookVerdict {
  readonly ok: boolean;
  readonly reason?: string;
  /** The provider's event id, for replay protection. */
  readonly eventId: string;
  readonly kind: "deposit" | "withdrawal" | "unknown";
  readonly providerRef: string | null;
  readonly amountMinor: number | null;
  readonly status: "succeeded" | "failed" | "pending" | "unknown";
}

/** A payout the admin or the provider is paying. */
export interface PayoutRequest {
  readonly withdrawalId: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly destination: string | null;
}

export interface PayoutResult {
  readonly providerRef: string;
  /** True when the money is already gone; false when a human still has to send it. */
  readonly paid: boolean;
}

export interface PaymentProvider {
  /** The name stored on deposit and withdrawal rows. */
  readonly name: string;
  /** True when this provider needs a human between the request and the money. */
  readonly manual: boolean;
  createDepositIntent(input: DepositIntentInput): Promise<DepositIntent>;
  /** Verifies a webhook's signature and reads its meaning. */
  verifyWebhook(headers: Readonly<Record<string, string | undefined>>, body: string): WebhookVerdict;
  createPayout(input: PayoutRequest): Promise<PayoutResult>;
}

/** Raised when a provider is asked for something it cannot do yet. */
export class ProviderNotConfiguredError extends Error {
  constructor(provider: string, what: string) {
    super(`the ${provider} provider is not configured: ${what}`);
    this.name = "ProviderNotConfiguredError";
  }
}
