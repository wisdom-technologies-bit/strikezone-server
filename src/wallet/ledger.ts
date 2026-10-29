import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.js";
import { ledgerCurrency } from "./payments.js";

/**
 * The wallet ledger: the only code in the repository that changes a balance
 * (AI_RULES.md hard rule 2).
 *
 * Two implementations sit behind one interface:
 *
 * - {@link SupabaseLedger} calls `public.post_ledger_transaction`, the SQL
 *   function from migration 002 that writes a transaction and its entries in one
 *   statement, refuses legs that do not sum to zero, refuses to overdraw a user
 *   account, and returns the original row when an idempotency key is replayed.
 * - {@link InMemoryLedger} enforces the same three rules in memory, so every
 *   money path in this repository can be tested without a database.
 *
 * Amounts are integers in the smallest unit, always. The zod schema below
 * refuses a float, a zero leg and a duplicated account, which keeps a rounding
 * bug from ever reaching the SQL function.
 */

/** The transaction kinds the ledger accepts (mirrors the check in migration 002). */
export const LEDGER_KINDS = [
  "deposit",
  "withdrawal",
  "bet_stake",
  "bet_payout",
  "bet_refund",
  "house_fee",
  "tournament_entry",
  "tournament_prize",
  "bankroll_topup",
  "adjustment",
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** One leg: an account and a signed amount. Credits are positive, debits negative. */
export const ledgerEntrySchema = z.strictObject({
  accountId: z.string().min(1).max(64),
  amountMinor: z.number().int().min(-9_000_000_000_000_000).max(9_000_000_000_000_000),
});

export type LedgerEntryInput = z.infer<typeof ledgerEntrySchema>;

/** Everything needed to post a balanced transaction. */
export const postTransactionSchema = z
  .strictObject({
    idempotencyKey: z.string().min(1).max(200),
    kind: z.enum(LEDGER_KINDS),
    refType: z.string().min(1).max(40).nullish(),
    refId: z.string().min(1).max(64).nullish(),
    entries: z.array(ledgerEntrySchema).min(2).max(64),
  })
  .refine((value) => value.entries.every((entry) => entry.amountMinor !== 0), {
    message: "an entry amount cannot be zero",
    path: ["entries"],
  })
  .refine(
    (value) => new Set(value.entries.map((entry) => entry.accountId)).size === value.entries.length,
    { message: "one entry per account", path: ["entries"] },
  )
  .refine((value) => value.entries.reduce((sum, entry) => sum + entry.amountMinor, 0) === 0, {
    message: "the entries must sum to exactly zero",
    path: ["entries"],
  });

export type PostTransactionInput = z.input<typeof postTransactionSchema>;

/** A posted transaction, as read back. */
export interface LedgerTransaction {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: LedgerKind;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly createdAt: string;
  readonly entries: readonly LedgerEntryInput[];
}

/** Raised when the ledger refuses a transaction. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** Everything the rest of the server needs from the ledger. */
export interface Ledger {
  /** The currency this ledger keeps. */
  readonly currency: string;
  post(input: PostTransactionInput): Promise<LedgerTransaction>;
  balanceOf(accountId: string): Promise<number>;
  /** The wallet of a profile, created on first use. */
  userAccount(profileId: string): Promise<string>;
  /** The house account: rake, fees and unclaimed prizes land here. */
  houseAccount(): Promise<string>;
  /** The prize pool of one tournament, created on first use. */
  prizePoolAccount(tournamentId: string): Promise<string>;
  /** Every transaction that names this ref, newest last. */
  transactionsFor(refType: string, refId: string): Promise<LedgerTransaction[]>;
  /** Total of the entries on one account, for audits and tests. */
  entriesFor(accountId: string): Promise<readonly LedgerEntryInput[]>;
}

// ---------------------------------------------------------------------------
// In memory: the implementation every test runs against
// ---------------------------------------------------------------------------

interface MemoryAccount {
  readonly id: string;
  readonly ownerType: "user" | "house" | "prize_pool" | "escrow";
  readonly userId: string | null;
  readonly tournamentId: string | null;
  readonly currency: string;
}

/**
 * An in-memory ledger with the database's rules: idempotent by key, legs must
 * sum to zero, and a user account may never go negative. House and prize pool
 * accounts are allowed to go negative only by a refund bug, so they are checked
 * too when the balance is known.
 */
export class InMemoryLedger implements Ledger {
  readonly currency: string;

  readonly #accounts = new Map<string, MemoryAccount>();
  readonly #balances = new Map<string, number>();
  readonly #transactions = new Map<string, LedgerTransaction>();
  readonly #byKey = new Map<string, string>();
  #next = 1;

  constructor(currency: string = ledgerCurrency()) {
    this.currency = currency;
  }

  async post(input: PostTransactionInput): Promise<LedgerTransaction> {
    const parsed = postTransactionSchema.safeParse(input);
    if (!parsed.success) {
      throw new LedgerError(
        `invalid transaction: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
      );
    }

    const value = parsed.data;
    const existingId = this.#byKey.get(value.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.#transactions.get(existingId);
      if (existing === undefined) {
        throw new LedgerError(`idempotency key ${value.idempotencyKey} is inconsistent`);
      }
      return existing;
    }

    // Validate every account before writing anything, then apply in one go.
    for (const entry of value.entries) {
      const account = this.#accounts.get(entry.accountId);
      if (account === undefined) {
        throw new LedgerError(`unknown account ${entry.accountId}`);
      }
      if (account.currency !== this.currency) {
        throw new LedgerError(
          `account ${entry.accountId} is in ${account.currency}, not ${this.currency}`,
        );
      }
    }

    for (const entry of value.entries) {
      if (entry.amountMinor >= 0) {
        continue;
      }
      const account = this.#accounts.get(entry.accountId);
      const balance = (this.#balances.get(entry.accountId) ?? 0) + entry.amountMinor;
      if (account?.ownerType === "user" && balance < 0) {
        throw new LedgerError(
          `account ${entry.accountId} would go below zero (${String(balance)})`,
        );
      }
      if (account?.ownerType === "prize_pool" && balance < 0) {
        throw new LedgerError(`prize pool ${entry.accountId} would go below zero`);
      }
    }

    const id = `txn_${this.#next}`;
    this.#next += 1;

    for (const entry of value.entries) {
      this.#balances.set(
        entry.accountId,
        (this.#balances.get(entry.accountId) ?? 0) + entry.amountMinor,
      );
    }

    const transaction: LedgerTransaction = {
      id,
      idempotencyKey: value.idempotencyKey,
      kind: value.kind,
      refType: value.refType ?? null,
      refId: value.refId ?? null,
      createdAt: new Date().toISOString(),
      entries: value.entries,
    };

    this.#transactions.set(id, transaction);
    this.#byKey.set(value.idempotencyKey, id);

    return transaction;
  }

  balanceOf(accountId: string): Promise<number> {
    return Promise.resolve(this.#balances.get(accountId) ?? 0);
  }

  userAccount(profileId: string): Promise<string> {
    for (const account of this.#accounts.values()) {
      if (account.ownerType === "user" && account.userId === profileId) {
        return Promise.resolve(account.id);
      }
    }
    const id = `acct_user_${profileId}`;
    this.#accounts.set(id, {
      id,
      ownerType: "user",
      userId: profileId,
      tournamentId: null,
      currency: this.currency,
    });
    return Promise.resolve(id);
  }

  houseAccount(): Promise<string> {
    for (const account of this.#accounts.values()) {
      if (account.ownerType === "house") {
        return Promise.resolve(account.id);
      }
    }
    const id = "acct_house";
    this.#accounts.set(id, {
      id,
      ownerType: "house",
      userId: null,
      tournamentId: null,
      currency: this.currency,
    });
    return Promise.resolve(id);
  }

  prizePoolAccount(tournamentId: string): Promise<string> {
    for (const account of this.#accounts.values()) {
      if (account.ownerType === "prize_pool" && account.tournamentId === tournamentId) {
        return Promise.resolve(account.id);
      }
    }
    const id = `acct_pool_${tournamentId}`;
    this.#accounts.set(id, {
      id,
      ownerType: "prize_pool",
      userId: null,
      tournamentId,
      currency: this.currency,
    });
    return Promise.resolve(id);
  }

  transactionsFor(refType: string, refId: string): Promise<LedgerTransaction[]> {
    const found = [...this.#transactions.values()].filter(
      (transaction) => transaction.refType === refType && transaction.refId === refId,
    );
    return Promise.resolve(found);
  }

  entriesFor(accountId: string): Promise<readonly LedgerEntryInput[]> {
    const entries: LedgerEntryInput[] = [];
    for (const transaction of this.#transactions.values()) {
      for (const entry of transaction.entries) {
        if (entry.accountId === accountId) {
          entries.push(entry);
        }
      }
    }
    return Promise.resolve(entries);
  }

  /** Every account, for an assertion that no money vanished. */
  allBalances(): Map<string, number> {
    return new Map(this.#balances);
  }
}

// ---------------------------------------------------------------------------
// Supabase: the production ledger
// ---------------------------------------------------------------------------

interface TransactionRow {
  id: string;
  idempotency_key: string;
  kind: string;
  ref_type: string | null;
  ref_id: string | null;
  created_at: string;
}

interface EntryRow {
  transaction_id: string;
  account_id: string;
  amount_minor: number | string;
}

interface AccountRow {
  id: string;
}

/** The ledger backed by `public.post_ledger_transaction` and the ledger tables. */
export class SupabaseLedger implements Ledger {
  readonly currency: string;

  readonly #client: SupabaseClient;

  constructor(currency: string = ledgerCurrency(), client: SupabaseClient = supabase) {
    this.currency = currency;
    this.#client = client;
  }

  async post(input: PostTransactionInput): Promise<LedgerTransaction> {
    const parsed = postTransactionSchema.safeParse(input);
    if (!parsed.success) {
      throw new LedgerError(
        `invalid transaction: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
      );
    }

    const value = parsed.data;

    const result = await this.#client.rpc("post_ledger_transaction", {
      p_idempotency_key: value.idempotencyKey,
      p_kind: value.kind,
      p_ref_type: value.refType ?? null,
      p_ref_id: value.refId ?? null,
      p_entries: value.entries.map((entry) => ({
        account_id: entry.accountId,
        amount_minor: entry.amountMinor,
      })),
    });

    if (result.error !== null) {
      throw new LedgerError(`the ledger refused the transaction: ${result.error.message}`);
    }

    // The function returns the transaction row, new or replayed: read it back
    // with its entries so callers see the same shape in both implementations.
    const returned = result.data as TransactionRow | null;
    if (returned === null || typeof returned.id !== "string") {
      throw new LedgerError("the ledger returned no transaction");
    }

    const entries = await this.#client
      .from("ledger_entries")
      .select("transaction_id, account_id, amount_minor")
      .eq("transaction_id", returned.id)
      .returns<EntryRow[]>();

    if (entries.error !== null) {
      throw new LedgerError(`could not read the entries: ${entries.error.message}`);
    }

    return {
      id: returned.id,
      idempotencyKey: returned.idempotency_key,
      kind: toKind(returned.kind),
      refType: returned.ref_type,
      refId: returned.ref_id,
      createdAt: returned.created_at,
      entries: (entries.data ?? []).map((row) => ({
        accountId: row.account_id,
        amountMinor: Number(row.amount_minor),
      })),
    };
  }

  async balanceOf(accountId: string): Promise<number> {
    const result = await this.#client
      .from("account_balances")
      .select("balance_minor")
      .eq("account_id", accountId)
      .maybeSingle<{ balance_minor: number | string }>();

    if (result.error !== null) {
      throw new LedgerError(`could not read the balance: ${result.error.message}`);
    }

    return result.data === null ? 0 : Number(result.data.balance_minor);
  }

  async userAccount(profileId: string): Promise<string> {
    const found = await this.#client
      .from("wallet_accounts")
      .select("id")
      .eq("owner_type", "user")
      .eq("user_id", profileId)
      .eq("currency", this.currency)
      .maybeSingle<AccountRow>();

    if (found.error !== null) {
      throw new LedgerError(`could not read the wallet: ${found.error.message}`);
    }
    if (found.data !== null) {
      return found.data.id;
    }

    const created = await this.#client
      .from("wallet_accounts")
      .insert({ owner_type: "user", user_id: profileId, currency: this.currency })
      .select("id")
      .maybeSingle<AccountRow>();

    if (created.error !== null) {
      // A concurrent insert won the race: read the row it created.
      const retry = await this.#client
        .from("wallet_accounts")
        .select("id")
        .eq("owner_type", "user")
        .eq("user_id", profileId)
        .eq("currency", this.currency)
        .maybeSingle<AccountRow>();
      if (retry.error === null && retry.data !== null) {
        return retry.data.id;
      }
      throw new LedgerError(`could not create the wallet: ${created.error.message}`);
    }
    if (created.data === null) {
      throw new LedgerError("the wallet insert returned no row");
    }

    return created.data.id;
  }

  async houseAccount(): Promise<string> {
    return this.#singletonAccount("house");
  }

  async prizePoolAccount(tournamentId: string): Promise<string> {
    const found = await this.#client
      .from("wallet_accounts")
      .select("id")
      .eq("owner_type", "prize_pool")
      .eq("tournament_id", tournamentId)
      .maybeSingle<AccountRow>();

    if (found.error !== null) {
      throw new LedgerError(`could not read the prize pool: ${found.error.message}`);
    }
    if (found.data !== null) {
      return found.data.id;
    }

    const created = await this.#client
      .from("wallet_accounts")
      .insert({
        owner_type: "prize_pool",
        tournament_id: tournamentId,
        currency: this.currency,
      })
      .select("id")
      .maybeSingle<AccountRow>();

    if (created.error !== null || created.data === null) {
      const retry = await this.#client
        .from("wallet_accounts")
        .select("id")
        .eq("owner_type", "prize_pool")
        .eq("tournament_id", tournamentId)
        .maybeSingle<AccountRow>();
      if (retry.error === null && retry.data !== null) {
        return retry.data.id;
      }
      throw new LedgerError(
        `could not create the prize pool: ${created.error?.message ?? "no row"}`,
      );
    }

    return created.data.id;
  }

  async transactionsFor(refType: string, refId: string): Promise<LedgerTransaction[]> {
    const result = await this.#client
      .from("ledger_transactions")
      .select("id, idempotency_key, kind, ref_type, ref_id, created_at")
      .eq("ref_type", refType)
      .eq("ref_id", refId)
      .order("created_at", { ascending: true })
      .returns<TransactionRow[]>();

    if (result.error !== null) {
      throw new LedgerError(`could not read the transactions: ${result.error.message}`);
    }

    const transactions: LedgerTransaction[] = [];
    for (const row of result.data ?? []) {
      transactions.push({
        id: row.id,
        idempotencyKey: row.idempotency_key,
        kind: toKind(row.kind),
        refType: row.ref_type,
        refId: row.ref_id,
        createdAt: row.created_at,
        entries: await this.#entriesOf(row.id),
      });
    }
    return transactions;
  }

  async entriesFor(accountId: string): Promise<readonly LedgerEntryInput[]> {
    const result = await this.#client
      .from("ledger_entries")
      .select("transaction_id, account_id, amount_minor")
      .eq("account_id", accountId)
      .returns<EntryRow[]>();

    if (result.error !== null) {
      throw new LedgerError(`could not read the entries: ${result.error.message}`);
    }

    return (result.data ?? []).map((row) => ({
      accountId: row.account_id,
      amountMinor: Number(row.amount_minor),
    }));
  }

  async #entriesOf(transactionId: string): Promise<readonly LedgerEntryInput[]> {
    const result = await this.#client
      .from("ledger_entries")
      .select("transaction_id, account_id, amount_minor")
      .eq("transaction_id", transactionId)
      .returns<EntryRow[]>();

    if (result.error !== null) {
      throw new LedgerError(`could not read the entries: ${result.error.message}`);
    }

    return (result.data ?? []).map((row) => ({
      accountId: row.account_id,
      amountMinor: Number(row.amount_minor),
    }));
  }

  async #singletonAccount(ownerType: "house" | "escrow"): Promise<string> {
    const found = await this.#client
      .from("wallet_accounts")
      .select("id")
      .eq("owner_type", ownerType)
      .eq("currency", this.currency)
      .maybeSingle<AccountRow>();

    if (found.error !== null) {
      throw new LedgerError(`could not read the ${ownerType} account: ${found.error.message}`);
    }
    if (found.data !== null) {
      return found.data.id;
    }

    const created = await this.#client
      .from("wallet_accounts")
      .insert({ owner_type: ownerType, currency: this.currency })
      .select("id")
      .maybeSingle<AccountRow>();

    if (created.error !== null || created.data === null) {
      const retry = await this.#client
        .from("wallet_accounts")
        .select("id")
        .eq("owner_type", ownerType)
        .eq("currency", this.currency)
        .maybeSingle<AccountRow>();
      if (retry.error === null && retry.data !== null) {
        return retry.data.id;
      }
      throw new LedgerError(`could not create the ${ownerType} account`);
    }

    return created.data.id;
  }
}

function toKind(value: string): LedgerKind {
  return (LEDGER_KINDS as readonly string[]).includes(value) ? (value as LedgerKind) : "adjustment";
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let override: Ledger | null = null;
let supabaseLedger: Ledger | null = null;

/** The ledger every caller uses. */
export function ledger(): Ledger {
  if (override !== null) {
    return override;
  }
  supabaseLedger ??= new SupabaseLedger();
  return supabaseLedger;
}

/** Replaces the ledger, for tests. Pass null to go back to Supabase. */
export function setLedger(replacement: Ledger | null): void {
  override = replacement;
}
