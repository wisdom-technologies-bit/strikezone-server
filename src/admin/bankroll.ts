import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../lib/env.js";
import { ledger, type Ledger } from "../wallet/ledger.js";
import { ledgerCurrency } from "../wallet/payments.js";
import { reportsSource } from "./reports.js";
import { adminStore, type AdminStore, type SolvencySnapshot } from "./store.js";

/**
 * The operator's money controls: putting cash in, seeing what is owed, proving
 * the book balances, and the two kill switches.
 *
 * Nothing here invents a balance. A top-up is a ledger transaction from the
 * treasury to the house, so every kobo the house can lose has a matching entry
 * on the other side. Solvency and reconcile are the database's own reports.
 */

export const topUpRequestSchema = z.strictObject({
  amountMinor: z.number().int().positive().max(9_000_000_000_000_000),
  note: z.string().max(200).optional(),
  /** Supply one to make a retried top-up a no-op instead of a second credit. */
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export type TopUpRequest = z.infer<typeof topUpRequestSchema>;

export const snapshotRequestSchema = z.strictObject({
  cashReportedMinor: z.number().int().min(0).max(9_000_000_000_000_000),
  note: z.string().max(200).optional(),
});

export type SnapshotRequest = z.infer<typeof snapshotRequestSchema>;

/** What the database says the position is. */
export interface SolvencyNumbers {
  readonly currency: string;
  readonly userBalancesMinor: number;
  readonly escrowMinor: number;
  readonly withdrawalHoldMinor: number;
  readonly houseMinor: number;
  readonly treasuryMinor: number;
  readonly prizePoolMinor: number;
  readonly openExposureMinor: number;
  readonly freeBankrollMinor: number;
  readonly heldPayoutsMinor: number;
  readonly openBetsMinor: number;
  readonly openWithdrawalsMinor: number;
}

/** The accounting invariants. Every difference must be zero. */
export interface ReconcileNumbers {
  readonly currency: string;
  readonly unbalancedTransactions: number;
  readonly accountsNotMatchingEntries: number;
  readonly negativeUserAccounts: number;
  readonly betsWithoutStake: number;
  readonly escrowActualMinor: number;
  readonly escrowExpectedMinor: number;
  readonly escrowDifferenceMinor: number;
  readonly holdActualMinor: number;
  readonly holdExpectedMinor: number;
  readonly holdDifferenceMinor: number;
  readonly transactions: number;
  readonly entries: number;
}

/** True when the book balances. */
export function reconcileClean(report: ReconcileNumbers): boolean {
  return (
    report.unbalancedTransactions === 0 &&
    report.accountsNotMatchingEntries === 0 &&
    report.negativeUserAccounts === 0 &&
    report.betsWithoutStake === 0 &&
    report.escrowDifferenceMinor === 0 &&
    report.holdDifferenceMinor === 0
  );
}

/** Where the reports come from. The database in production, a fake in tests. */
export interface ReportsSource {
  solvency(currency: string): Promise<SolvencyNumbers>;
  reconcile(currency: string): Promise<ReconcileNumbers>;
}

export interface AdminDeps {
  readonly ledger?: Ledger;
  readonly store?: AdminStore;
  readonly reports?: ReportsSource;
  readonly now?: () => Date;
}

/** Records what was done, before reporting it done. */
async function audit(
  store: AdminStore,
  entry: {
    readonly action: string;
    readonly targetType: string | null;
    readonly targetId: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
  },
  actor: string,
  at: string,
): Promise<void> {
  await store.recordAction({ ...entry, actor, at });
}

/** Adds money the operator has put in: treasury to house, through the ledger. */
export async function topUpBankroll(
  request: TopUpRequest,
  actor: string,
  deps: AdminDeps = {},
): Promise<{ readonly ledgerTransactionKey: string }> {
  const book = deps.ledger ?? ledger();
  const store = deps.store ?? adminStore();
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const key = request.idempotencyKey ?? `topup:${randomUUID()}`;

  await book.post({
    idempotencyKey: key,
    kind: "bankroll_topup",
    refType: "bankroll",
    refId: null,
    entries: [
      { accountId: await book.treasuryAccount(), amountMinor: -request.amountMinor },
      { accountId: await book.houseAccount(), amountMinor: request.amountMinor },
    ],
  });

  await audit(
    store,
    {
      action: "bankroll_topup",
      targetType: "house",
      targetId: null,
      payload: { amountMinor: request.amountMinor, key, note: request.note ?? null },
    },
    actor,
    at,
  );

  return { ledgerTransactionKey: key };
}

/** What players hold, what is owed, what the house has, and what is at risk. */
export async function solvency(
  deps: AdminDeps = {},
): Promise<SolvencyNumbers & { readonly lastSnapshot: SolvencySnapshot | null }> {
  const reports = deps.reports ?? reportsSource();
  const store = deps.store ?? adminStore();
  const numbers = await reports.solvency(ledgerCurrency());
  return { ...numbers, lastSnapshot: await store.latestSnapshot() };
}

/**
 * Stores the cash the operator says they hold, next to what the ledger says
 * players are owed, and says loudly when the cash is short.
 */
export async function recordSnapshot(
  request: SnapshotRequest,
  actor: string,
  deps: AdminDeps = {},
): Promise<{
  readonly snapshot: SolvencySnapshot;
  readonly gapMinor: number;
  readonly warning: string | null;
}> {
  const reports = deps.reports ?? reportsSource();
  const store = deps.store ?? adminStore();
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const numbers = await reports.solvency(ledgerCurrency());

  // What players could ask for today: their wallets, plus withdrawals in flight.
  const liabilities = numbers.userBalancesMinor + numbers.withdrawalHoldMinor;
  const snapshot = await store.insertSnapshot({
    cashReportedMinor: request.cashReportedMinor,
    userLiabilitiesMinor: liabilities,
    houseFundsMinor: numbers.houseMinor,
    note: request.note ?? null,
  });

  const gapMinor = request.cashReportedMinor - liabilities;
  const warning =
    gapMinor < 0
      ? `short by ${String(-gapMinor)} in minor units: players could ask for more than you hold`
      : null;

  await audit(
    store,
    {
      action: "solvency_snapshot",
      targetType: "solvency_snapshot",
      targetId: snapshot.id,
      payload: { cashReportedMinor: request.cashReportedMinor, liabilities, gapMinor },
    },
    actor,
    at,
  );

  return { snapshot, gapMinor, warning };
}

/** The accounting invariants, as the database computes them. */
export async function reconcile(deps: AdminDeps = {}): Promise<
  ReconcileNumbers & { readonly clean: boolean }
> {
  const reports = deps.reports ?? reportsSource();
  const numbers = await reports.reconcile(ledgerCurrency());
  return { ...numbers, clean: reconcileClean(numbers) };
}

/** The global betting switch. */
export async function pauseBetting(
  paused: boolean,
  actor: string,
  deps: AdminDeps = {},
): Promise<{ readonly paused: boolean }> {
  const store = deps.store ?? adminStore();
  const at = (deps.now ?? (() => new Date()))().toISOString();

  await store.setBettingPaused(paused, actor);
  await audit(
    store,
    {
      action: paused ? "betting_paused" : "betting_resumed",
      targetType: "system_flag",
      targetId: "betting",
      payload: { paused },
    },
    actor,
    at,
  );

  return { paused };
}

/** True when the platform is paused. Read by the bets route for a fast refusal. */
export async function bettingPaused(deps: AdminDeps = {}): Promise<boolean> {
  const store = deps.store ?? adminStore();
  return store.bettingPaused();
}

/** The largest payout an admin may hold and the reason it is held. */
export const LARGE_PAYOUT_MINOR = env.LARGE_PAYOUT_MINOR;
