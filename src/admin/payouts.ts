import { ledger, type Ledger } from "../wallet/ledger.js";
import { betsRepository } from "../betting/bets-store-store.js";
import type { BetsRepository } from "../betting/bets-store.js";
import type { BetRow } from "../betting/types.js";
import { adminStore, type AdminStore } from "./store.js";

/**
 * Held payouts: the bets whose winnings were too large to release on their own.
 *
 * The money never left escrow at settlement, so approving is the only thing that
 * pays it, and rejecting is a refund. Both are idempotent by their own keys,
 * which is why a double click cannot pay twice.
 */

export interface PayoutDeps {
  readonly ledger?: Ledger;
  readonly bets?: BetsRepository;
  readonly store?: AdminStore;
  readonly now?: () => Date;
}

export class PayoutRefused extends Error {
  readonly code: "not_found" | "not_held";

  constructor(code: PayoutRefused["code"], message: string) {
    super(message);
    this.name = "PayoutRefused";
    this.code = code;
  }
}

/** Releases a held payout: escrow returns the stake, the house pays the profit. */
export async function approvePayout(
  betId: string,
  actor: string,
  deps: PayoutDeps = {},
): Promise<BetRow> {
  const bets = deps.bets ?? betsRepository();
  const book = deps.ledger ?? ledger();
  const store = deps.store ?? adminStore();
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const bet = await bets.get(betId);
  if (bet === null) {
    throw new PayoutRefused("not_found", `no bet ${betId}`);
  }
  if (bet.status !== "pending_review") {
    throw new PayoutRefused("not_held", `bet ${betId} is ${bet.status}, not waiting for review`);
  }

  const payout = bet.payoutMinor ?? bet.potentialPayoutMinor;
  const profit = payout - bet.stakeMinor;

  await book.post({
    idempotencyKey: `settle:${bet.id}`,
    kind: "bet_payout",
    refType: "bet",
    refId: bet.id,
    entries: [
      { accountId: await book.escrowAccount(), amountMinor: -bet.stakeMinor },
      { accountId: await book.userAccount(bet.userId), amountMinor: payout },
      { accountId: await book.houseAccount(), amountMinor: -profit },
    ].filter((entry) => entry.amountMinor !== 0),
  });

  await bets.review(bet.id, { status: "won", reviewedAt: at, reviewedBy: actor });

  await store.recordAction({
    action: "payout_approved",
    targetType: "bet",
    targetId: bet.id,
    payload: { payoutMinor: payout, stakeMinor: bet.stakeMinor },
    actor,
    at,
  });

  const updated = await bets.get(bet.id);
  if (updated === null) {
    throw new PayoutRefused("not_found", `bet ${betId} vanished`);
  }
  return updated;
}

/**
 * Refuses a held payout: the stake goes back and the bet becomes void.
 *
 * A payout is held when it is large, not when it is suspicious, so the default
 * outcome of a review is to pay. A rejection is a decision that the bet should
 * not stand at all, and it refunds rather than keeping the stake.
 */
export async function rejectPayout(
  betId: string,
  actor: string,
  reason: string,
  deps: PayoutDeps = {},
): Promise<BetRow> {
  const bets = deps.bets ?? betsRepository();
  const book = deps.ledger ?? ledger();
  const store = deps.store ?? adminStore();
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const bet = await bets.get(betId);
  if (bet === null) {
    throw new PayoutRefused("not_found", `no bet ${betId}`);
  }
  if (bet.status !== "pending_review") {
    throw new PayoutRefused("not_held", `bet ${betId} is ${bet.status}, not waiting for review`);
  }

  await book.post({
    idempotencyKey: `settle-void:${bet.id}`,
    kind: "bet_refund",
    refType: "bet",
    refId: bet.id,
    entries: [
      { accountId: await book.escrowAccount(), amountMinor: -bet.stakeMinor },
      { accountId: await book.userAccount(bet.userId), amountMinor: bet.stakeMinor },
    ],
  });

  await bets.review(bet.id, { status: "void", reviewedAt: at, reviewedBy: actor });

  await store.recordAction({
    action: "payout_rejected",
    targetType: "bet",
    targetId: bet.id,
    payload: { reason, stakeMinor: bet.stakeMinor },
    actor,
    at,
  });

  const updated = await bets.get(bet.id);
  if (updated === null) {
    throw new PayoutRefused("not_found", `bet ${betId} vanished`);
  }
  return updated;
}
