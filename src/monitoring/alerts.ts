import { randomUUID } from "node:crypto";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";

/**
 * Alerts: the conditions an operator has to be woken for.
 *
 * The order is deliberate. The row is written first, because a row survives a
 * webhook that times out and a webhook does not survive a process that died. The
 * POST is best effort, and its failure is logged rather than thrown: an alert
 * that could not be delivered is still an alert, and a settlement must never
 * fail because the notifier did.
 */

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertInput {
  /** Stable code to filter on: bankroll_low, settlement_failed, verification_failed. */
  readonly code: string;
  readonly severity: AlertSeverity;
  readonly message: string;
  /** Everything needed to understand it without a second query. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly matchId?: string | null;
  readonly userId?: string | null;
}

export interface AlertRow extends AlertInput {
  readonly id: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
}

export interface AlertStore {
  record(input: AlertInput & { readonly at: string }): Promise<AlertRow>;
  list(limit: number): Promise<AlertRow[]>;
  openCount(): Promise<number>;
}

interface AlertShape {
  readonly id: string;
  readonly code: string;
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly context: Record<string, unknown>;
  readonly match_id: string | null;
  readonly user_id: string | null;
  readonly acknowledged_at: string | null;
  readonly acknowledged_by: string | null;
  readonly created_at: string;
}

export class AlertStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertStoreError";
  }
}

const toRow = (row: AlertShape): AlertRow => ({
  id: row.id,
  code: row.code,
  severity: row.severity,
  message: row.message,
  context: row.context,
  matchId: row.match_id,
  userId: row.user_id,
  createdAt: row.created_at,
  acknowledgedAt: row.acknowledged_at,
  acknowledgedBy: row.acknowledged_by,
});

const ALERT_COLUMNS =
  "id, code, severity, message, context, match_id, user_id, acknowledged_at, acknowledged_by, created_at";

export class SupabaseAlertStore implements AlertStore {
  async record(input: AlertInput & { readonly at: string }): Promise<AlertRow> {
    const result = await supabase
      .from("alerts")
      .insert({
        code: input.code,
        severity: input.severity,
        message: input.message,
        context: input.context ?? {},
        match_id: input.matchId ?? null,
        user_id: input.userId ?? null,
        created_at: input.at,
      })
      .select(ALERT_COLUMNS)
      .single<AlertShape>();

    if (result.error !== null) {
      throw new AlertStoreError(`could not write the alert: ${result.error.message}`);
    }
    return toRow(result.data);
  }

  async list(limit: number): Promise<AlertRow[]> {
    const result = await supabase
      .from("alerts")
      .select(ALERT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<AlertShape[]>();

    if (result.error !== null) {
      throw new AlertStoreError(`could not read the alerts: ${result.error.message}`);
    }
    return (result.data ?? []).map(toRow);
  }

  async openCount(): Promise<number> {
    const result = await supabase
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .is("acknowledged_at", null);

    if (result.error !== null) {
      throw new AlertStoreError(`could not count the alerts: ${result.error.message}`);
    }
    return result.count ?? 0;
  }
}

export class InMemoryAlertStore implements AlertStore {
  readonly #rows: AlertRow[] = [];

  record(input: AlertInput & { readonly at: string }): Promise<AlertRow> {
    const row: AlertRow = {
      ...input,
      id: randomUUID(),
      createdAt: input.at,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };
    this.#rows.unshift(row);
    return Promise.resolve(row);
  }

  list(limit: number): Promise<AlertRow[]> {
    return Promise.resolve(this.#rows.slice(0, limit));
  }

  openCount(): Promise<number> {
    return Promise.resolve(this.#rows.filter((row) => row.acknowledgedAt === null).length);
  }
}

let store: AlertStore | null = null;

/** The alert store in use: Supabase unless a test replaced it. */
export function alertStore(): AlertStore {
  store ??= new SupabaseAlertStore();
  return store;
}

/** Replaces the store. Tests only; null restores the default. */
export function setAlertStore(replacement: AlertStore | null): void {
  store = replacement;
}

/** How a webhook is delivered. Injectable so a test never dials out. */
export type AlertDeliver = (url: string, body: string) => Promise<void>;

const post: AlertDeliver = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`the webhook answered ${String(response.status)}`);
  }
};

let deliver: AlertDeliver = post;

/** Replaces the webhook transport. Tests only; null restores the default. */
export function setAlertDeliver(replacement: AlertDeliver | null): void {
  deliver = replacement ?? post;
}

/**
 * Writes an alert and, if a webhook is configured, posts it.
 *
 * Never throws. An alert is a report about a failure: a reporter that fails the
 * caller would turn one broken settlement into two.
 */
export async function raiseAlert(input: AlertInput): Promise<AlertRow | null> {
  const at = new Date().toISOString();

  let row: AlertRow | null = null;
  try {
    row = await alertStore().record({ ...input, at });
  } catch (error) {
    logger.error({ err: error, code: input.code }, "could not write the alert");
  }

  const url = env.ALERT_WEBHOOK_URL;
  if (url !== undefined && url !== "") {
    try {
      await deliver(
        url,
        JSON.stringify({
          code: input.code,
          severity: input.severity,
          message: input.message,
          context: input.context ?? {},
          matchId: input.matchId ?? null,
          userId: input.userId ?? null,
          at,
        }),
      );
    } catch (error) {
      logger.warn({ err: error, code: input.code }, "could not deliver the alert webhook");
    }
  }

  logger.warn({ code: input.code, severity: input.severity }, input.message);
  return row;
}

/**
 * The bankroll floor.
 *
 * A house that cannot pay what it owes is not a warning about the next hour, it
 * is the condition the whole ledger exists to make visible, so it is reported at
 * the severity that wakes somebody.
 */
export async function checkBankrollFloor(freeBankrollMinor: number): Promise<void> {
  const floor = env.ALERT_FREE_BANKROLL_MINOR;
  if (freeBankrollMinor >= floor) {
    return;
  }
  await raiseAlert({
    code: "bankroll_low",
    severity: "critical",
    message: `free bankroll ${String(freeBankrollMinor)} is below the floor of ${String(floor)}`,
    context: { freeBankrollMinor, floorMinor: floor },
  });
}
