import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import {
  assertMayDeposit,
  limitsRepository,
  type LimitsRepository,
  PlayBlocked,
} from "../betting/limits.js";
import { ledger, type Ledger } from "./ledger.js";
import { paymentAdapter } from "./payments.js";
import { paymentsRepository, type DepositRow, type PaymentsRepository } from "./payments-store.js";
import { activeProvider, providerByName, type PaymentProvider } from "./providers/index.js";

/**
 * Money coming in.
 *
 * Two shapes of deposit, one rule: the ledger is the only thing that credits a
 * player, and it is keyed by the deposit row's id. Whether the money arrives
 * from a mock that settles instantly, an admin confirming a bank transfer, or a
 * webhook redelivered three times, the player is credited once.
 */

export const depositRequestSchema = z.strictObject({
  amountMinor: z.number().int().positive().max(9_000_000_000_000_000),
  /** Defaults to the provider this process is configured with. */
  provider: z.string().min(1).max(40).optional(),
});

export type DepositRequest = z.infer<typeof depositRequestSchema>;

export interface DepositDeps {
  readonly payments?: PaymentsRepository;
  readonly ledger?: Ledger;
  readonly limits?: LimitsRepository;
  readonly provider?: PaymentProvider;
  readonly now?: () => Date;
}

/** A started deposit: the row, and where the player should go to pay. */
export interface StartedDeposit {
  readonly deposit: DepositRow;
  readonly redirectUrl: string | null;
  readonly credited: boolean;
}

/** Starts a deposit: gate it, ask the provider, then credit what is already in. */
export async function startDeposit(
  userId: string,
  request: DepositRequest,
  deps: DepositDeps = {},
): Promise<StartedDeposit> {
  const payments = deps.payments ?? paymentsRepository();
  const limits = deps.limits ?? limitsRepository();
  const provider =
    request.provider === undefined
      ? (deps.provider ?? activeProvider())
      : providerByName(request.provider);

  if (provider === null) {
    throw new PlayBlocked("kyc_required", {
      reason: `no provider named ${String(request.provider)}`,
    });
  }

  const at = (deps.now ?? (() => new Date()))();

  // Responsible play first: an excluded player cannot put money in, and a daily
  // deposit limit is measured against what is already credited today.
  await assertMayDeposit(userId, request.amountMinor, limits, at);

  const currency = paymentAdapter().currency;
  const intent = await provider.createDepositIntent({
    userId,
    amountMinor: request.amountMinor,
    currency,
    reference: `deposit-${randomUUID()}`,
  });

  const deposit = await payments.createDeposit({
    userId,
    provider: provider.name,
    providerRef: intent.providerRef,
    amountMinor: request.amountMinor,
    currency,
    status: "pending",
  });

  if (!intent.credited) {
    return { deposit, redirectUrl: intent.redirectUrl ?? null, credited: false };
  }

  const credited = await creditDeposit(deposit.id, deps);
  return { deposit: credited, redirectUrl: intent.redirectUrl ?? null, credited: true };
}

/**
 * Credits a pending deposit through the ledger, once.
 *
 * The key is `deposit:<id>`: a second call posts nothing new, so an admin double
 * clicking and a webhook redelivery both land on the same transaction.
 */
export async function creditDeposit(
  depositId: string,
  deps: DepositDeps = {},
): Promise<DepositRow> {
  const payments = deps.payments ?? paymentsRepository();
  const book = deps.ledger ?? ledger();

  const deposit = await payments.getDeposit(depositId);
  if (deposit === null) {
    throw new Error(`no deposit ${depositId}`);
  }
  if (deposit.status === "credited") {
    return deposit;
  }
  if (deposit.status !== "pending") {
    throw new Error(`deposit ${depositId} is ${deposit.status}, not pending`);
  }

  const userAccount = await book.userAccount(deposit.userId);
  const treasury = await book.treasuryAccount();

  await book.post({
    idempotencyKey: `deposit:${deposit.id}`,
    kind: "deposit",
    refType: "deposit",
    refId: deposit.id,
    entries: [
      { accountId: treasury, amountMinor: -deposit.amountMinor },
      { accountId: userAccount, amountMinor: deposit.amountMinor },
    ],
  });

  await payments.markDeposit(deposit.id, {
    status: "credited",
    creditedAt: new Date().toISOString(),
  });

  const updated = await payments.getDeposit(deposit.id);
  if (updated === null) {
    throw new Error(`deposit ${depositId} vanished`);
  }
  return updated;
}

/** What the webhook route reports back to the provider. */
export interface WebhookOutcome {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly outcome: string;
  readonly reason?: string;
}

/**
 * Handles a provider webhook: verify, remember, then act once.
 *
 * A webhook is stored before it is acted on and its event id is unique, so a
 * redelivery is recognised rather than replayed. The signature is verified over
 * the raw body, which is why the route keeps it.
 */
export async function handlePaymentWebhook(
  providerName: string,
  headers: Readonly<Record<string, string | undefined>>,
  rawBody: string,
  deps: DepositDeps = {},
): Promise<WebhookOutcome> {
  const payments = deps.payments ?? paymentsRepository();
  const provider = providerByName(providerName);

  if (provider === null) {
    return { accepted: false, duplicate: false, outcome: "unknown_provider" };
  }

  const verdict = provider.verifyWebhook(headers, rawBody);
  if (!verdict.ok) {
    logger.warn({ provider: providerName, reason: verdict.reason }, "refused a payment webhook");
    return {
      accepted: false,
      duplicate: false,
      outcome: "signature_rejected",
      reason: verdict.reason ?? "invalid",
    };
  }

  if (verdict.kind === "deposit") {
    if (verdict.providerRef === null) {
      return { accepted: false, duplicate: false, outcome: "missing_reference" };
    }

    const deposit = await payments.getDepositByRef(providerName, verdict.providerRef);
    if (deposit === null) {
      await payments.recordWebhook({
        provider: providerName,
        eventId: verdict.eventId,
        payload: verdict,
        outcome: "unknown_deposit",
      });
      return { accepted: true, duplicate: false, outcome: "unknown_deposit" };
    }

    const first = await payments.recordWebhook({
      provider: providerName,
      eventId: verdict.eventId,
      payload: verdict,
      outcome: verdict.status,
    });
    if (!first) {
      return { accepted: true, duplicate: true, outcome: "already_processed" };
    }

    if (verdict.status !== "succeeded") {
      await payments.markDeposit(deposit.id, { status: "failed" });
      return { accepted: true, duplicate: false, outcome: "deposit_failed" };
    }

    // The amount must match: a webhook that pays a different sum is a bug or an
    // attack, and either way it does not credit.
    if (verdict.amountMinor !== null && verdict.amountMinor !== deposit.amountMinor) {
      logger.error(
        { depositId: deposit.id, expected: deposit.amountMinor, reported: verdict.amountMinor },
        "webhook amount does not match the deposit",
      );
      return { accepted: true, duplicate: false, outcome: "amount_mismatch" };
    }

    await creditDeposit(deposit.id, deps);
    return { accepted: true, duplicate: false, outcome: "deposit_credited" };
  }

  const first = await payments.recordWebhook({
    provider: providerName,
    eventId: verdict.eventId,
    payload: verdict,
    outcome: verdict.kind,
  });

  return {
    accepted: true,
    duplicate: !first,
    outcome: verdict.kind === "withdrawal" ? "withdrawal_event_recorded" : "ignored",
  };
}
