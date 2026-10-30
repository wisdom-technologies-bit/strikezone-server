import { z } from "zod";
import { env } from "../lib/env.js";
import {
  accountOldEnough,
  isExcluded,
  limitsRepository,
  type LimitsRepository,
} from "../betting/limits.js";
import { ledger, type Ledger } from "./ledger.js";
import { paymentAdapter } from "./payments.js";
import {
  paymentsRepository,
  type PaymentsRepository,
  type WithdrawalRow,
} from "./payments-store.js";
import { activeProvider, type PaymentProvider } from "./providers/index.js";

/**
 * Money going out.
 *
 * The amount leaves the player the moment they ask: free balance moves to
 * `withdrawal_hold` through the ledger. From there only two things can happen.
 * An admin pays it (the hold goes to the treasury, where the operator's own cash
 * lives) or rejects it (the hold goes back to the player). Approval alone moves
 * no money, so "approved" and "paid" can never be confused.
 *
 * A player can only withdraw free balance: stakes at risk are already in escrow,
 * so the wallet balance is exactly what is theirs.
 */

export const withdrawalRequestSchema = z.strictObject({
  amountMinor: z.number().int().positive().max(9_000_000_000_000_000),
  /** A bank account or wallet address, kept for the human paying it. */
  destination: z.string().min(1).max(120).optional(),
});

export type WithdrawalRequest = z.infer<typeof withdrawalRequestSchema>;

export interface WithdrawalDeps {
  readonly payments?: PaymentsRepository;
  readonly ledger?: Ledger;
  readonly limits?: LimitsRepository;
  readonly provider?: PaymentProvider;
  readonly now?: () => Date;
}

/** Raised when a withdrawal cannot be requested. */
export class WithdrawalRefused extends Error {
  readonly code:
    | "amount_invalid"
    | "insufficient_funds"
    | "kyc_required"
    | "account_too_new"
    | "not_found"
    | "wrong_status";

  constructor(code: WithdrawalRefused["code"], message: string) {
    super(message);
    this.name = "WithdrawalRefused";
    this.code = code;
  }
}

/** Requests a withdrawal and moves the money into the hold account. */
export async function requestWithdrawal(
  userId: string,
  request: WithdrawalRequest,
  deps: WithdrawalDeps = {},
): Promise<WithdrawalRow> {
  const payments = deps.payments ?? paymentsRepository();
  const book = deps.ledger ?? ledger();
  const limits = deps.limits ?? limitsRepository();
  const provider = deps.provider ?? activeProvider();
  const at = (deps.now ?? (() => new Date()))();

  const state = await limits.getPlayState(userId);
  if (state === null) {
    throw new WithdrawalRefused("not_found", "no such player");
  }

  // Real money needs an identity and an account that has had time to cool.
  if (paymentAdapter().mode === "real") {
    if (state.kycStatus !== "verified") {
      throw new WithdrawalRefused("kyc_required", "identity must be verified before a withdrawal");
    }
    if (!accountOldEnough(state, at, env.MIN_ACCOUNT_AGE_HOURS)) {
      throw new WithdrawalRefused(
        "account_too_new",
        `an account must be ${String(env.MIN_ACCOUNT_AGE_HOURS)} hours old before it withdraws`,
      );
    }
  }

  const balance = await book.balanceOf(await book.userAccount(userId));
  if (balance < request.amountMinor) {
    throw new WithdrawalRefused("insufficient_funds", "the wallet does not cover this withdrawal");
  }

  const withdrawal = await payments.createWithdrawal({
    userId,
    amountMinor: request.amountMinor,
    currency: paymentAdapter().currency,
    provider: provider.name,
    destination: request.destination ?? null,
  });

  try {
    await book.post({
      idempotencyKey: `withdrawal-hold:${withdrawal.id}`,
      kind: "withdrawal",
      refType: "withdrawal",
      refId: withdrawal.id,
      entries: [
        { accountId: await book.userAccount(userId), amountMinor: -request.amountMinor },
        { accountId: await book.withdrawalHoldAccount(), amountMinor: request.amountMinor },
      ],
    });
  } catch (error) {
    // The money did not move, so the request must not stand as if it had.
    await payments.advanceWithdrawal(withdrawal.id, {
      status: "rejected",
      decidedAt: at.toISOString(),
      decidedBy: "system",
      reason: "could not hold the funds",
    });
    throw error;
  }

  return withdrawal;
}

/** Approves a request: a human decision, no money movement. */
export async function approveWithdrawal(
  withdrawalId: string,
  actor: string,
  deps: WithdrawalDeps = {},
): Promise<WithdrawalRow> {
  const payments = deps.payments ?? paymentsRepository();
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const withdrawal = await payments.getWithdrawal(withdrawalId);
  if (withdrawal === null) {
    throw new WithdrawalRefused("not_found", `no withdrawal ${withdrawalId}`);
  }
  if (withdrawal.status !== "requested") {
    throw new WithdrawalRefused("wrong_status", `withdrawal is ${withdrawal.status}`);
  }

  await payments.advanceWithdrawal(withdrawalId, {
    status: "approved",
    decidedAt: at,
    decidedBy: actor,
  });

  const updated = await payments.getWithdrawal(withdrawalId);
  if (updated === null) {
    throw new WithdrawalRefused("not_found", `withdrawal ${withdrawalId} vanished`);
  }
  return updated;
}

/**
 * Marks an approved withdrawal paid.
 *
 * The provider is asked first (a real one would send the transfer here), then
 * the hold is released to the treasury: the money has left the platform.
 */
export async function markWithdrawalPaid(
  withdrawalId: string,
  actor: string,
  deps: WithdrawalDeps = {},
): Promise<WithdrawalRow> {
  const payments = deps.payments ?? paymentsRepository();
  const book = deps.ledger ?? ledger();
  const provider = deps.provider ?? activeProvider();
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const withdrawal = await payments.getWithdrawal(withdrawalId);
  if (withdrawal === null) {
    throw new WithdrawalRefused("not_found", `no withdrawal ${withdrawalId}`);
  }
  if (withdrawal.status !== "approved" && withdrawal.status !== "requested") {
    throw new WithdrawalRefused("wrong_status", `withdrawal is ${withdrawal.status}`);
  }

  const payout = await provider.createPayout({
    withdrawalId: withdrawal.id,
    userId: withdrawal.userId,
    amountMinor: withdrawal.amountMinor,
    destination: withdrawal.destination,
  });

  await book.post({
    idempotencyKey: `withdrawal-paid:${withdrawal.id}`,
    kind: "withdrawal",
    refType: "withdrawal",
    refId: withdrawal.id,
    entries: [
      { accountId: await book.withdrawalHoldAccount(), amountMinor: -withdrawal.amountMinor },
      { accountId: await book.treasuryAccount(), amountMinor: withdrawal.amountMinor },
    ],
  });

  await payments.advanceWithdrawal(withdrawalId, {
    status: "paid",
    paidAt: at,
    decidedAt: withdrawal.decidedAt ?? at,
    decidedBy: actor,
    providerRef: payout.providerRef,
  });

  const updated = await payments.getWithdrawal(withdrawalId);
  if (updated === null) {
    throw new WithdrawalRefused("not_found", `withdrawal ${withdrawalId} vanished`);
  }
  return updated;
}

/** Rejects a request: the money goes back to the player, from the hold. */
export async function rejectWithdrawal(
  withdrawalId: string,
  actor: string,
  reason: string,
  deps: WithdrawalDeps = {},
): Promise<WithdrawalRow> {
  const payments = deps.payments ?? paymentsRepository();
  const book = deps.ledger ?? ledger();
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const withdrawal = await payments.getWithdrawal(withdrawalId);
  if (withdrawal === null) {
    throw new WithdrawalRefused("not_found", `no withdrawal ${withdrawalId}`);
  }
  if (withdrawal.status === "paid" || withdrawal.status === "rejected") {
    throw new WithdrawalRefused("wrong_status", `withdrawal is ${withdrawal.status}`);
  }

  await book.post({
    idempotencyKey: `withdrawal-reject:${withdrawal.id}`,
    kind: "withdrawal",
    refType: "withdrawal",
    refId: withdrawal.id,
    entries: [
      { accountId: await book.withdrawalHoldAccount(), amountMinor: -withdrawal.amountMinor },
      { accountId: await book.userAccount(withdrawal.userId), amountMinor: withdrawal.amountMinor },
    ],
  });

  await payments.advanceWithdrawal(withdrawalId, {
    status: "rejected",
    decidedAt: at,
    decidedBy: actor,
    reason,
  });

  const updated = await payments.getWithdrawal(withdrawalId);
  if (updated === null) {
    throw new WithdrawalRefused("not_found", `withdrawal ${withdrawalId} vanished`);
  }
  return updated;
}

/** True when the player is currently excluded from play, for the profile view. */
export async function exclusionState(
  userId: string,
  deps: WithdrawalDeps = {},
): Promise<{ readonly excluded: boolean; readonly until: string | null }> {
  const limits = deps.limits ?? limitsRepository();
  const state = await limits.getPlayState(userId);
  if (state === null) {
    return { excluded: false, until: null };
  }
  return { excluded: isExcluded(state, new Date()), until: state.selfExcludedUntil };
}
