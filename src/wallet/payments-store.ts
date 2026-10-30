import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.js";

/**
 * The rows around a payment: deposits coming in, withdrawals going out, and the
 * webhooks that reported either.
 *
 * A deposit is credited once, keyed by the provider's reference; a withdrawal is
 * paid once, keyed by its own id. Both keys live in the database as unique
 * constraints, so the same message arriving twice cannot move money twice.
 */

export type DepositStatus = "pending" | "credited" | "failed" | "cancelled";
export type WithdrawalStatus = "requested" | "approved" | "paid" | "rejected";

export interface DepositRow {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: DepositStatus;
  readonly note: string | null;
  readonly createdAt: string;
  readonly creditedAt: string | null;
}

export interface WithdrawalRow {
  readonly id: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly provider: string;
  readonly providerRef: string | null;
  readonly status: WithdrawalStatus;
  readonly destination: string | null;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly paidAt: string | null;
  readonly decidedBy: string | null;
}

export interface CreateDepositInput {
  readonly userId: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: DepositStatus;
  readonly note?: string | null;
}

export interface CreateWithdrawalInput {
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly provider: string;
  readonly destination?: string | null;
}

export interface PaymentsRepository {
  createDeposit(input: CreateDepositInput): Promise<DepositRow>;
  getDeposit(depositId: string): Promise<DepositRow | null>;
  getDepositByRef(provider: string, providerRef: string): Promise<DepositRow | null>;
  markDeposit(
    depositId: string,
    patch: { readonly status: DepositStatus; readonly creditedAt?: string | null },
  ): Promise<void>;

  createWithdrawal(input: CreateWithdrawalInput): Promise<WithdrawalRow>;
  getWithdrawal(withdrawalId: string): Promise<WithdrawalRow | null>;
  /** Moves a withdrawal on, only from the status it currently holds. */
  advanceWithdrawal(
    withdrawalId: string,
    patch: {
      readonly status: WithdrawalStatus;
      readonly decidedAt?: string | null;
      readonly paidAt?: string | null;
      readonly decidedBy?: string | null;
      readonly providerRef?: string | null;
      readonly reason?: string | null;
    },
  ): Promise<void>;
  listWithdrawals(userId: string): Promise<WithdrawalRow[]>;
  listOpenWithdrawals(): Promise<WithdrawalRow[]>;

  /** Records a webhook, once. Returns false when it had already been seen. */
  recordWebhook(input: {
    readonly provider: string;
    readonly eventId: string;
    readonly payload: unknown;
    readonly outcome: string;
  }): Promise<boolean>;
}

export class PaymentsRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentsRepositoryError";
  }
}

interface DepositShape {
  id: string;
  user_id: string;
  provider: string;
  provider_ref: string;
  amount_minor: number | string;
  currency: string;
  status: string;
  note: string | null;
  created_at: string;
  credited_at: string | null;
}

interface WithdrawalShape {
  id: string;
  user_id: string;
  amount_minor: number | string;
  currency: string;
  provider: string;
  provider_ref: string | null;
  status: string;
  destination: string | null;
  reason: string | null;
  requested_at: string;
  decided_at: string | null;
  paid_at: string | null;
  decided_by: string | null;
}

const DEPOSIT_COLUMNS =
  "id, user_id, provider, provider_ref, amount_minor, currency, status, note, created_at, credited_at";

const WITHDRAWAL_COLUMNS =
  "id, user_id, amount_minor, currency, provider, provider_ref, status, destination, reason, requested_at, decided_at, paid_at, decided_by";

function toDeposit(row: DepositShape): DepositRow {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status as DepositStatus,
    note: row.note,
    createdAt: row.created_at,
    creditedAt: row.credited_at,
  };
}

function toWithdrawal(row: WithdrawalShape): WithdrawalRow {
  return {
    id: row.id,
    userId: row.user_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    provider: row.provider,
    providerRef: row.provider_ref,
    status: row.status as WithdrawalStatus,
    destination: row.destination,
    reason: row.reason,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    paidAt: row.paid_at,
    decidedBy: row.decided_by,
  };
}

export class SupabasePaymentsRepository implements PaymentsRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async createDeposit(input: CreateDepositInput): Promise<DepositRow> {
    const result = await this.#client
      .from("deposits")
      .insert({
        user_id: input.userId,
        provider: input.provider,
        provider_ref: input.providerRef,
        amount_minor: input.amountMinor,
        currency: input.currency,
        status: input.status,
        note: input.note ?? null,
      })
      .select(DEPOSIT_COLUMNS)
      .maybeSingle<DepositShape>();

    if (result.error !== null || result.data === null) {
      throw new PaymentsRepositoryError(
        `could not create the deposit: ${result.error?.message ?? "no row"}`,
      );
    }
    return toDeposit(result.data);
  }

  async getDeposit(depositId: string): Promise<DepositRow | null> {
    const result = await this.#client
      .from("deposits")
      .select(DEPOSIT_COLUMNS)
      .eq("id", depositId)
      .maybeSingle<DepositShape>();

    if (result.error !== null) {
      throw new PaymentsRepositoryError(`could not read the deposit: ${result.error.message}`);
    }
    return result.data === null ? null : toDeposit(result.data);
  }

  async getDepositByRef(provider: string, providerRef: string): Promise<DepositRow | null> {
    const result = await this.#client
      .from("deposits")
      .select(DEPOSIT_COLUMNS)
      .eq("provider", provider)
      .eq("provider_ref", providerRef)
      .maybeSingle<DepositShape>();

    if (result.error !== null) {
      throw new PaymentsRepositoryError(`could not read the deposit: ${result.error.message}`);
    }
    return result.data === null ? null : toDeposit(result.data);
  }

  async markDeposit(
    depositId: string,
    patch: { readonly status: DepositStatus; readonly creditedAt?: string | null },
  ): Promise<void> {
    const result = await this.#client
      .from("deposits")
      .update({
        status: patch.status,
        credited_at:
          patch.status === "credited" ? (patch.creditedAt ?? new Date().toISOString()) : null,
      })
      .eq("id", depositId)
      .eq("status", "pending");

    if (result.error !== null) {
      throw new PaymentsRepositoryError(`could not update the deposit: ${result.error.message}`);
    }
  }

  async createWithdrawal(input: CreateWithdrawalInput): Promise<WithdrawalRow> {
    const result = await this.#client
      .from("withdrawals")
      .insert({
        user_id: input.userId,
        amount_minor: input.amountMinor,
        currency: input.currency,
        provider: input.provider,
        destination: input.destination ?? null,
      })
      .select(WITHDRAWAL_COLUMNS)
      .maybeSingle<WithdrawalShape>();

    if (result.error !== null || result.data === null) {
      throw new PaymentsRepositoryError(
        `could not create the withdrawal: ${result.error?.message ?? "no row"}`,
      );
    }
    return toWithdrawal(result.data);
  }

  async getWithdrawal(withdrawalId: string): Promise<WithdrawalRow | null> {
    const result = await this.#client
      .from("withdrawals")
      .select(WITHDRAWAL_COLUMNS)
      .eq("id", withdrawalId)
      .maybeSingle<WithdrawalShape>();

    if (result.error !== null) {
      throw new PaymentsRepositoryError(`could not read the withdrawal: ${result.error.message}`);
    }
    return result.data === null ? null : toWithdrawal(result.data);
  }

  async advanceWithdrawal(
    withdrawalId: string,
    patch: {
      readonly status: WithdrawalStatus;
      readonly decidedAt?: string | null;
      readonly paidAt?: string | null;
      readonly decidedBy?: string | null;
      readonly providerRef?: string | null;
      readonly reason?: string | null;
    },
  ): Promise<void> {
    const update: Record<string, string | null> = { status: patch.status };
    if (patch.decidedAt !== undefined) {
      update["decided_at"] = patch.decidedAt;
    }
    if (patch.paidAt !== undefined) {
      update["paid_at"] = patch.paidAt;
    }
    if (patch.decidedBy !== undefined) {
      update["decided_by"] = patch.decidedBy;
    }
    if (patch.providerRef !== undefined) {
      update["provider_ref"] = patch.providerRef;
    }
    if (patch.reason !== undefined) {
      update["reason"] = patch.reason;
    }

    const result = await this.#client.from("withdrawals").update(update).eq("id", withdrawalId);

    if (result.error !== null) {
      throw new PaymentsRepositoryError(`could not update the withdrawal: ${result.error.message}`);
    }
  }

  async listWithdrawals(userId: string): Promise<WithdrawalRow[]> {
    const result = await this.#client
      .from("withdrawals")
      .select(WITHDRAWAL_COLUMNS)
      .eq("user_id", userId)
      .order("requested_at", { ascending: false })
      .returns<WithdrawalShape[]>();

    if (result.error !== null) {
      throw new PaymentsRepositoryError(`could not read the withdrawals: ${result.error.message}`);
    }
    return (result.data ?? []).map(toWithdrawal);
  }

  async listOpenWithdrawals(): Promise<WithdrawalRow[]> {
    const result = await this.#client
      .from("withdrawals")
      .select(WITHDRAWAL_COLUMNS)
      .in("status", ["requested", "approved"])
      .order("requested_at", { ascending: true })
      .returns<WithdrawalShape[]>();

    if (result.error !== null) {
      throw new PaymentsRepositoryError(`could not read the withdrawals: ${result.error.message}`);
    }
    return (result.data ?? []).map(toWithdrawal);
  }

  async recordWebhook(input: {
    readonly provider: string;
    readonly eventId: string;
    readonly payload: unknown;
    readonly outcome: string;
  }): Promise<boolean> {
    const result = await this.#client.from("payment_webhook_events").insert({
      provider: input.provider,
      event_id: input.eventId,
      payload: input.payload,
      outcome: input.outcome,
      processed_at: new Date().toISOString(),
    });

    if (result.error !== null) {
      // 23505 is the unique violation: this event has been seen before.
      if (result.error.code === "23505") {
        return false;
      }
      throw new PaymentsRepositoryError(`could not record the webhook: ${result.error.message}`);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

/** A payments store in memory, for the deposit, withdrawal and webhook tests. */
export class InMemoryPaymentsRepository implements PaymentsRepository {
  readonly #deposits = new Map<string, DepositRow>();
  readonly #withdrawals = new Map<string, WithdrawalRow>();
  readonly #webhooks = new Set<string>();
  #nextDeposit = 1;
  #nextWithdrawal = 1;

  createDeposit(input: CreateDepositInput): Promise<DepositRow> {
    for (const existing of this.#deposits.values()) {
      if (existing.provider === input.provider && existing.providerRef === input.providerRef) {
        return Promise.reject(new PaymentsRepositoryError("that provider reference is used"));
      }
    }
    const id = `dep_${String(this.#nextDeposit)}`;
    this.#nextDeposit += 1;
    const row: DepositRow = {
      id,
      userId: input.userId,
      provider: input.provider,
      providerRef: input.providerRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: input.status,
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
      creditedAt: null,
    };
    this.#deposits.set(id, row);
    return Promise.resolve(row);
  }

  getDeposit(depositId: string): Promise<DepositRow | null> {
    return Promise.resolve(this.#deposits.get(depositId) ?? null);
  }

  getDepositByRef(provider: string, providerRef: string): Promise<DepositRow | null> {
    for (const row of this.#deposits.values()) {
      if (row.provider === provider && row.providerRef === providerRef) {
        return Promise.resolve(row);
      }
    }
    return Promise.resolve(null);
  }

  markDeposit(
    depositId: string,
    patch: { readonly status: DepositStatus; readonly creditedAt?: string | null },
  ): Promise<void> {
    const row = this.#deposits.get(depositId);
    if (row === undefined) {
      return Promise.reject(new PaymentsRepositoryError(`no deposit ${depositId}`));
    }
    if (row.status !== "pending") {
      return Promise.resolve();
    }
    this.#deposits.set(depositId, {
      ...row,
      status: patch.status,
      creditedAt:
        patch.status === "credited" ? (patch.creditedAt ?? new Date().toISOString()) : null,
    });
    return Promise.resolve();
  }

  createWithdrawal(input: CreateWithdrawalInput): Promise<WithdrawalRow> {
    const id = `wd_${String(this.#nextWithdrawal)}`;
    this.#nextWithdrawal += 1;
    const row: WithdrawalRow = {
      id,
      userId: input.userId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      provider: input.provider,
      providerRef: null,
      status: "requested",
      destination: input.destination ?? null,
      reason: null,
      requestedAt: new Date().toISOString(),
      decidedAt: null,
      paidAt: null,
      decidedBy: null,
    };
    this.#withdrawals.set(id, row);
    return Promise.resolve(row);
  }

  getWithdrawal(withdrawalId: string): Promise<WithdrawalRow | null> {
    return Promise.resolve(this.#withdrawals.get(withdrawalId) ?? null);
  }

  advanceWithdrawal(
    withdrawalId: string,
    patch: {
      readonly status: WithdrawalStatus;
      readonly decidedAt?: string | null;
      readonly paidAt?: string | null;
      readonly decidedBy?: string | null;
      readonly providerRef?: string | null;
      readonly reason?: string | null;
    },
  ): Promise<void> {
    const row = this.#withdrawals.get(withdrawalId);
    if (row === undefined) {
      return Promise.reject(new PaymentsRepositoryError(`no withdrawal ${withdrawalId}`));
    }
    this.#withdrawals.set(withdrawalId, {
      ...row,
      status: patch.status,
      decidedAt: patch.decidedAt === undefined ? row.decidedAt : patch.decidedAt,
      paidAt: patch.paidAt === undefined ? row.paidAt : patch.paidAt,
      decidedBy: patch.decidedBy === undefined ? row.decidedBy : patch.decidedBy,
      providerRef: patch.providerRef === undefined ? row.providerRef : patch.providerRef,
      reason: patch.reason === undefined ? row.reason : patch.reason,
    });
    return Promise.resolve();
  }

  listWithdrawals(userId: string): Promise<WithdrawalRow[]> {
    return Promise.resolve([...this.#withdrawals.values()].filter((row) => row.userId === userId));
  }

  listOpenWithdrawals(): Promise<WithdrawalRow[]> {
    return Promise.resolve(
      [...this.#withdrawals.values()].filter(
        (row) => row.status === "requested" || row.status === "approved",
      ),
    );
  }

  recordWebhook(input: {
    readonly provider: string;
    readonly eventId: string;
    readonly payload: unknown;
    readonly outcome: string;
  }): Promise<boolean> {
    const key = `${input.provider}:${input.eventId}`;
    if (this.#webhooks.has(key)) {
      return Promise.resolve(false);
    }
    this.#webhooks.add(key);
    return Promise.resolve(true);
  }

  /** Every deposit, for assertions. */
  deposits(): DepositRow[] {
    return [...this.#deposits.values()];
  }

  /** Every withdrawal, for assertions. */
  withdrawals(): WithdrawalRow[] {
    return [...this.#withdrawals.values()];
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let override: PaymentsRepository | null = null;
let supabasePayments: PaymentsRepository | null = null;

export function paymentsRepository(): PaymentsRepository {
  if (override !== null) {
    return override;
  }
  supabasePayments ??= new SupabasePaymentsRepository();
  return supabasePayments;
}

export function setPaymentsRepository(replacement: PaymentsRepository | null): void {
  override = replacement;
}
