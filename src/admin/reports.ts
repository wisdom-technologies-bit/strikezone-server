import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.js";
import type { ReconcileNumbers, ReportsSource, SolvencyNumbers } from "./bankroll.js";

/**
 * The solvency and reconcile reports, straight from the database.
 *
 * Both are SQL functions in migration 009, so the numbers the operator sees are
 * computed by the same engine that holds the rows, not re-derived in JavaScript
 * from a partial read.
 */

interface RawSolvency {
  currency?: string;
  userBalancesMinor?: number | string;
  escrowMinor?: number | string;
  withdrawalHoldMinor?: number | string;
  houseMinor?: number | string;
  treasuryMinor?: number | string;
  prizePoolMinor?: number | string;
  openExposureMinor?: number | string;
  freeBankrollMinor?: number | string;
  heldPayoutsMinor?: number | string;
  openBetsMinor?: number | string;
  openWithdrawalsMinor?: number | string;
}

interface RawReconcile {
  currency?: string;
  unbalancedTransactions?: number | string;
  accountsNotMatchingEntries?: number | string;
  negativeUserAccounts?: number | string;
  betsWithoutStake?: number | string;
  escrowActualMinor?: number | string;
  escrowExpectedMinor?: number | string;
  escrowDifferenceMinor?: number | string;
  holdActualMinor?: number | string;
  holdExpectedMinor?: number | string;
  holdDifferenceMinor?: number | string;
  transactions?: number | string;
  entries?: number | string;
}

const num = (value: number | string | undefined): number => Number(value ?? 0);

export class SupabaseReports implements ReportsSource {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async solvency(currency: string): Promise<SolvencyNumbers> {
    const result = await this.#client.rpc("solvency_report", { p_currency: currency });
    if (result.error !== null) {
      throw new Error(`could not read the solvency report: ${result.error.message}`);
    }
    const raw = (result.data ?? {}) as RawSolvency;
    return {
      currency: raw.currency ?? currency,
      userBalancesMinor: num(raw.userBalancesMinor),
      escrowMinor: num(raw.escrowMinor),
      withdrawalHoldMinor: num(raw.withdrawalHoldMinor),
      houseMinor: num(raw.houseMinor),
      treasuryMinor: num(raw.treasuryMinor),
      prizePoolMinor: num(raw.prizePoolMinor),
      openExposureMinor: num(raw.openExposureMinor),
      freeBankrollMinor: num(raw.freeBankrollMinor),
      heldPayoutsMinor: num(raw.heldPayoutsMinor),
      openBetsMinor: num(raw.openBetsMinor),
      openWithdrawalsMinor: num(raw.openWithdrawalsMinor),
    };
  }

  async reconcile(currency: string): Promise<ReconcileNumbers> {
    const result = await this.#client.rpc("reconcile_report", { p_currency: currency });
    if (result.error !== null) {
      throw new Error(`could not read the reconcile report: ${result.error.message}`);
    }
    const raw = (result.data ?? {}) as RawReconcile;
    return {
      currency: raw.currency ?? currency,
      unbalancedTransactions: num(raw.unbalancedTransactions),
      accountsNotMatchingEntries: num(raw.accountsNotMatchingEntries),
      negativeUserAccounts: num(raw.negativeUserAccounts),
      betsWithoutStake: num(raw.betsWithoutStake),
      escrowActualMinor: num(raw.escrowActualMinor),
      escrowExpectedMinor: num(raw.escrowExpectedMinor),
      escrowDifferenceMinor: num(raw.escrowDifferenceMinor),
      holdActualMinor: num(raw.holdActualMinor),
      holdExpectedMinor: num(raw.holdExpectedMinor),
      holdDifferenceMinor: num(raw.holdDifferenceMinor),
      transactions: num(raw.transactions),
      entries: num(raw.entries),
    };
  }
}

let override: ReportsSource | null = null;
let supabaseReports: ReportsSource | null = null;

export function reportsSource(): ReportsSource {
  if (override !== null) {
    return override;
  }
  supabaseReports ??= new SupabaseReports();
  return supabaseReports;
}

export function setReportsSource(replacement: ReportsSource | null): void {
  override = replacement;
}
