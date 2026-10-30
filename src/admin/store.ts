import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.js";

/**
 * The operator's own tables: the audit trail, the flags and the snapshots.
 *
 * Every admin action that changes something writes a row here first, so the
 * question "who paused betting, and when" has an answer that cannot be edited.
 */

export interface AdminAction {
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly actor: string;
  readonly at: string;
}

export interface SolvencySnapshot {
  readonly id: string;
  readonly cashReportedMinor: number;
  readonly userLiabilitiesMinor: number;
  readonly houseFundsMinor: number;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface AdminStore {
  recordAction(entry: AdminAction): Promise<void>;
  listActions(limit: number): Promise<AdminAction[]>;
  bettingPaused(): Promise<boolean>;
  setBettingPaused(paused: boolean, actor: string): Promise<void>;
  insertSnapshot(input: {
    readonly cashReportedMinor: number;
    readonly userLiabilitiesMinor: number;
    readonly houseFundsMinor: number;
    readonly note: string | null;
  }): Promise<SolvencySnapshot>;
  latestSnapshot(): Promise<SolvencySnapshot | null>;
}

export class AdminStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminStoreError";
  }
}

interface ActionShape {
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  actor: string;
  created_at: string;
}

interface SnapshotShape {
  id: string;
  cash_reported_minor: number | string;
  user_liabilities_minor: number | string;
  house_funds_minor: number | string;
  note: string | null;
  created_at: string;
}

function toSnapshot(row: SnapshotShape): SolvencySnapshot {
  return {
    id: row.id,
    cashReportedMinor: Number(row.cash_reported_minor),
    userLiabilitiesMinor: Number(row.user_liabilities_minor),
    houseFundsMinor: Number(row.house_funds_minor),
    note: row.note,
    createdAt: row.created_at,
  };
}

export class SupabaseAdminStore implements AdminStore {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async recordAction(entry: AdminAction): Promise<void> {
    const result = await this.#client.from("admin_actions").insert({
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      payload: entry.payload,
      actor: entry.actor,
      created_at: entry.at,
    });

    if (result.error !== null) {
      throw new AdminStoreError(`could not write the audit row: ${result.error.message}`);
    }
  }

  async listActions(limit: number): Promise<AdminAction[]> {
    const result = await this.#client
      .from("admin_actions")
      .select("action, target_type, target_id, payload, actor, created_at")
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<ActionShape[]>();

    if (result.error !== null) {
      throw new AdminStoreError(`could not read the audit trail: ${result.error.message}`);
    }

    return (result.data ?? []).map((row) => ({
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      payload: row.payload,
      actor: row.actor,
      at: row.created_at,
    }));
  }

  async bettingPaused(): Promise<boolean> {
    const result = await this.#client
      .from("system_flags")
      .select("value")
      .eq("key", "betting")
      .maybeSingle<{ value: { paused?: boolean } }>();

    if (result.error !== null) {
      throw new AdminStoreError(`could not read the flags: ${result.error.message}`);
    }
    return result.data?.value.paused === true;
  }

  async setBettingPaused(paused: boolean, actor: string): Promise<void> {
    const result = await this.#client.from("system_flags").upsert(
      {
        key: "betting",
        value: { paused },
        updated_at: new Date().toISOString(),
        updated_by: actor,
      },
      { onConflict: "key" },
    );

    if (result.error !== null) {
      throw new AdminStoreError(`could not set the flag: ${result.error.message}`);
    }
  }

  async insertSnapshot(input: {
    readonly cashReportedMinor: number;
    readonly userLiabilitiesMinor: number;
    readonly houseFundsMinor: number;
    readonly note: string | null;
  }): Promise<SolvencySnapshot> {
    const result = await this.#client
      .from("solvency_snapshots")
      .insert({
        cash_reported_minor: input.cashReportedMinor,
        user_liabilities_minor: input.userLiabilitiesMinor,
        house_funds_minor: input.houseFundsMinor,
        note: input.note,
      })
      .select(
        "id, cash_reported_minor, user_liabilities_minor, house_funds_minor, note, created_at",
      )
      .maybeSingle<SnapshotShape>();

    if (result.error !== null || result.data === null) {
      throw new AdminStoreError(
        `could not store the snapshot: ${result.error?.message ?? "no row"}`,
      );
    }
    return toSnapshot(result.data);
  }

  async latestSnapshot(): Promise<SolvencySnapshot | null> {
    const result = await this.#client
      .from("solvency_snapshots")
      .select(
        "id, cash_reported_minor, user_liabilities_minor, house_funds_minor, note, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<SnapshotShape>();

    if (result.error !== null) {
      throw new AdminStoreError(`could not read the snapshots: ${result.error.message}`);
    }
    return result.data === null ? null : toSnapshot(result.data);
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

export class InMemoryAdminStore implements AdminStore {
  readonly #actions: AdminAction[] = [];
  readonly #snapshots: SolvencySnapshot[] = [];
  #paused = false;
  #next = 1;

  recordAction(entry: AdminAction): Promise<void> {
    this.#actions.push(entry);
    return Promise.resolve();
  }

  listActions(limit: number): Promise<AdminAction[]> {
    return Promise.resolve([...this.#actions].reverse().slice(0, limit));
  }

  bettingPaused(): Promise<boolean> {
    return Promise.resolve(this.#paused);
  }

  setBettingPaused(paused: boolean): Promise<void> {
    this.#paused = paused;
    return Promise.resolve();
  }

  insertSnapshot(input: {
    readonly cashReportedMinor: number;
    readonly userLiabilitiesMinor: number;
    readonly houseFundsMinor: number;
    readonly note: string | null;
  }): Promise<SolvencySnapshot> {
    const snapshot: SolvencySnapshot = {
      id: `snap_${String(this.#next)}`,
      cashReportedMinor: input.cashReportedMinor,
      userLiabilitiesMinor: input.userLiabilitiesMinor,
      houseFundsMinor: input.houseFundsMinor,
      note: input.note,
      createdAt: new Date().toISOString(),
    };
    this.#next += 1;
    this.#snapshots.push(snapshot);
    return Promise.resolve(snapshot);
  }

  latestSnapshot(): Promise<SolvencySnapshot | null> {
    return Promise.resolve(this.#snapshots.at(-1) ?? null);
  }

  /** Every action written, for assertions. */
  actions(): AdminAction[] {
    return [...this.#actions];
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let override: AdminStore | null = null;
let supabaseAdmin: AdminStore | null = null;

export function adminStore(): AdminStore {
  if (override !== null) {
    return override;
  }
  supabaseAdmin ??= new SupabaseAdminStore();
  return supabaseAdmin;
}

export function setAdminStore(replacement: AdminStore | null): void {
  override = replacement;
}
