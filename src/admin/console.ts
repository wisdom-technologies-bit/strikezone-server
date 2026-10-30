import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { alertStore, type AlertRow } from "../monitoring/alerts.js";
import { reportsSource } from "./reports.js";
import { adminStore, type AdminAction } from "./store.js";

/**
 * The operator's console: what is happening, and the switches to change it.
 *
 * Reads are aggregated here rather than in the routes, so the same numbers serve
 * the HTTP API and any future CLI, and a test can replace the whole data layer
 * with the in-memory implementation below.
 */

export type BotLevel = "rookie" | "club" | "master";
export const BOT_LEVELS: readonly BotLevel[] = ["rookie", "club", "master"];

export interface BotView {
  readonly botId: string;
  readonly level: BotLevel;
  /** The published numbers, or null while the catalogue's own numbers apply. */
  readonly numbers: Readonly<Record<string, unknown>> | null;
  readonly updatedAt: string | null;
}

export interface ExposureByMatch {
  readonly matchId: string;
  readonly exposureMinor: number;
  readonly openBets: number;
}

export interface AdminOverview {
  readonly currency: string;
  readonly liveMatches: number;
  readonly liveMatchIds: readonly string[];
  readonly openExposureMinor: number;
  readonly exposureByMatch: readonly ExposureByMatch[];
  readonly freeBankrollMinor: number;
  readonly pendingReviews: number;
  readonly flaggedMatches: number;
  readonly activeTournaments: number;
  readonly openAlerts: number;
  readonly bettingPaused: boolean;
  readonly usersInSelfExclusion: number;
}

export interface DeepHealth {
  readonly ok: boolean;
  readonly database: {
    readonly ok: boolean;
    readonly latencyMs: number;
    readonly error: string | null;
  };
  readonly liveMatches: number;
  readonly lastRepriceByMatch: readonly { readonly matchId: string; readonly at: string | null }[];
  readonly scheduler: {
    readonly leases: readonly { readonly name: string; readonly expiresAt: string | null }[];
  };
  readonly workerPool: {
    readonly cores: number;
    readonly threadsPerPrice: number;
    readonly mode: "workers" | "inline";
  };
  readonly alertsOpen: number;
  readonly uptimeSeconds: number;
}

export interface AuditFilter {
  readonly action?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly limit: number;
}

export interface PublishBotInput {
  readonly botId: string;
  readonly level: BotLevel;
  readonly numbers: Readonly<Record<string, number>>;
  readonly note?: string | undefined;
}

export interface SuspendMarketInput {
  readonly matchId: string;
  readonly marketType: string;
  readonly subject?: string | undefined;
  readonly line?: number | null | undefined;
  readonly suspended: boolean;
}

export interface MarketOverrideInput {
  readonly marketType: string;
  readonly maxStakeMinor?: number | undefined;
  readonly marginBps?: number | undefined;
  readonly note?: string | undefined;
}

export interface AdminConsole {
  overview(): Promise<AdminOverview>;
  listBots(): Promise<readonly BotView[]>;
  botHistory(botId: string): Promise<readonly BotView[]>;
  publishBot(input: PublishBotInput, actor: string): Promise<BotView>;
  suspendMarket(input: SuspendMarketInput, actor: string): Promise<number>;
  setMarketOverride(input: MarketOverrideInput, actor: string): Promise<void>;
  setSelfExclusion(userId: string, until: string | null, actor: string): Promise<void>;
  setKyc(
    userId: string,
    status: "none" | "pending" | "verified" | "rejected",
    actor: string,
  ): Promise<void>;
  setFrozen(userId: string, frozen: boolean, actor: string): Promise<void>;
  auditLog(filter: AuditFilter): Promise<readonly AdminAction[]>;
  alerts(limit: number): Promise<readonly AlertRow[]>;
  health(): Promise<DeepHealth>;
}

export class ConsoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleError";
  }
}

interface BotShape {
  readonly bot_id: string;
  readonly level: BotLevel;
  readonly numbers: Record<string, unknown>;
  readonly created_at: string;
}

const toBot = (row: BotShape): BotView => ({
  botId: row.bot_id,
  level: row.level,
  numbers: row.numbers,
  updatedAt: row.created_at,
});

const BOT_COLUMNS = "bot_id, level, numbers, created_at";

/** The database implementation. Every write is audited before it reports success. */
export class SupabaseAdminConsole implements AdminConsole {
  async #audit(
    action: string,
    targetType: string | null,
    targetId: string | null,
    payload: Readonly<Record<string, unknown>>,
    actor: string,
  ): Promise<void> {
    await adminStore().recordAction({
      action,
      targetType,
      targetId,
      payload,
      actor,
      at: new Date().toISOString(),
    });
  }

  async overview(): Promise<AdminOverview> {
    const [solvency, live, flagged, tournaments, alerts, paused] = await Promise.all([
      reportsSource().solvency(env.CURRENCY),
      supabase.from("matches").select("id").eq("status", "live").returns<{ id: string }[]>(),
      supabase
        .from("bets")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending_review"),
      supabase
        .from("tournaments")
        .select("id", { count: "exact", head: true })
        .in("status", ["open", "running"]),
      alertStore().openCount(),
      adminStore().bettingPaused(),
    ]);

    if (live.error !== null) {
      throw new ConsoleError(`could not read the live matches: ${live.error.message}`);
    }

    const liveMatchIds = (live.data ?? []).map((row) => row.id);
    const exposureByMatch = await this.#exposure(liveMatchIds);

    return {
      currency: env.CURRENCY,
      liveMatches: liveMatchIds.length,
      liveMatchIds,
      openExposureMinor: solvency.openExposureMinor,
      exposureByMatch,
      freeBankrollMinor: solvency.freeBankrollMinor,
      pendingReviews: flagged.count ?? 0,
      flaggedMatches: flagged.count ?? 0,
      activeTournaments: tournaments.count ?? 0,
      openAlerts: alerts,
      bettingPaused: paused,
      usersInSelfExclusion: 0,
    };
  }

  /** Open liability per live match: what the book owes if every open bet wins. */
  async #exposure(matchIds: readonly string[]): Promise<ExposureByMatch[]> {
    if (matchIds.length === 0) {
      return [];
    }

    const result = await supabase
      .from("bets")
      .select("potential_payout_minor, markets!inner (match_id)")
      .eq("status", "open")
      .in("markets.match_id", [...matchIds])
      .returns<{ potential_payout_minor: number; markets: { match_id: string } }[]>();

    if (result.error !== null) {
      throw new ConsoleError(`could not read the exposure: ${result.error.message}`);
    }

    const byMatch = new Map<string, { exposureMinor: number; openBets: number }>();
    for (const row of result.data ?? []) {
      const entry = byMatch.get(row.markets.match_id) ?? { exposureMinor: 0, openBets: 0 };
      entry.exposureMinor += row.potential_payout_minor;
      entry.openBets += 1;
      byMatch.set(row.markets.match_id, entry);
    }

    return [...byMatch.entries()].map(([matchId, entry]) => ({ matchId, ...entry }));
  }

  async listBots(): Promise<readonly BotView[]> {
    const result = await supabase
      .from("bot_publications")
      .select(BOT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(200)
      .returns<BotShape[]>();

    if (result.error !== null) {
      throw new ConsoleError(`could not read the bot publications: ${result.error.message}`);
    }

    // Newest first, so the first row per bot is the one in force.
    const seen = new Set<string>();
    const latest: BotView[] = [];
    for (const row of result.data ?? []) {
      if (seen.has(row.bot_id)) {
        continue;
      }
      seen.add(row.bot_id);
      latest.push(toBot(row));
    }

    // Every level appears, published or not.
    for (const level of BOT_LEVELS) {
      if (!latest.some((bot) => bot.botId === level)) {
        latest.push({ botId: level, level, numbers: null, updatedAt: null });
      }
    }
    return latest;
  }

  async botHistory(botId: string): Promise<readonly BotView[]> {
    const result = await supabase
      .from("bot_publications")
      .select(BOT_COLUMNS)
      .eq("bot_id", botId)
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<BotShape[]>();

    if (result.error !== null) {
      throw new ConsoleError(`could not read the bot history: ${result.error.message}`);
    }
    return (result.data ?? []).map(toBot);
  }

  async publishBot(input: PublishBotInput, actor: string): Promise<BotView> {
    const previous = (await this.botHistory(input.botId))[0]?.numbers ?? null;

    const inserted = await supabase
      .from("bot_publications")
      .insert({
        bot_id: input.botId,
        level: input.level,
        numbers: input.numbers,
        previous,
        actor,
      })
      .select(BOT_COLUMNS)
      .single<BotShape>();

    if (inserted.error !== null) {
      throw new ConsoleError(`could not publish the bot numbers: ${inserted.error.message}`);
    }

    await this.#audit(
      "bot.published",
      "bot",
      input.botId,
      { numbers: input.numbers, previous, note: input.note ?? null },
      actor,
    );
    return toBot(inserted.data);
  }

  async suspendMarket(input: SuspendMarketInput, actor: string): Promise<number> {
    const status = input.suspended ? "suspended" : "open";
    const result = await supabase
      .from("markets")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("match_id", input.matchId)
      .eq("market_type", input.marketType)
      .eq("subject", input.subject ?? "")
      .eq("status", input.suspended ? "open" : "suspended")
      .select("id")
      .returns<{ id: string }[]>();

    if (result.error !== null) {
      throw new ConsoleError(`could not change the market status: ${result.error.message}`);
    }

    const changed = (result.data ?? []).length;
    await this.#audit(
      input.suspended ? "market.suspended" : "market.resumed",
      "market",
      `${input.matchId}:${input.marketType}`,
      { subject: input.subject ?? "", line: input.line ?? null, changed },
      actor,
    );
    return changed;
  }

  async setMarketOverride(input: MarketOverrideInput, actor: string): Promise<void> {
    const result = await supabase.from("market_overrides").upsert(
      {
        market_type: input.marketType,
        max_stake_minor: input.maxStakeMinor ?? null,
        margin_bps: input.marginBps ?? null,
        note: input.note ?? null,
        updated_by: actor,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "market_type" },
    );

    if (result.error !== null) {
      throw new ConsoleError(`could not write the market override: ${result.error.message}`);
    }

    await this.#audit(
      "market.override",
      "market_type",
      input.marketType,
      { maxStakeMinor: input.maxStakeMinor ?? null, marginBps: input.marginBps ?? null },
      actor,
    );
  }

  async #updateProfile(
    action: string,
    userId: string,
    patch: Readonly<Record<string, unknown>>,
    actor: string,
  ): Promise<void> {
    const result = await supabase.from("profiles").update(patch).eq("id", userId);
    if (result.error !== null) {
      throw new ConsoleError(`could not update the profile: ${result.error.message}`);
    }
    await this.#audit(action, "user", userId, patch, actor);
  }

  async setSelfExclusion(userId: string, until: string | null, actor: string): Promise<void> {
    await this.#updateProfile(
      "user.self_exclusion",
      userId,
      {
        self_excluded_until: until,
        self_exclusion_kind: until === null ? null : "self_exclusion",
      },
      actor,
    );
  }

  async setKyc(
    userId: string,
    status: "none" | "pending" | "verified" | "rejected",
    actor: string,
  ): Promise<void> {
    await this.#updateProfile("user.kyc", userId, { kyc_status: status }, actor);
  }

  async setFrozen(userId: string, frozen: boolean, actor: string): Promise<void> {
    const until = frozen ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : null;
    await this.#updateProfile("user.frozen", userId, { frozen_until: until }, actor);
  }

  async auditLog(filter: AuditFilter): Promise<readonly AdminAction[]> {
    let query = supabase
      .from("admin_actions")
      .select("action, target_type, target_id, payload, actor, created_at")
      .order("created_at", { ascending: false })
      .limit(filter.limit);

    if (filter.action !== undefined) {
      query = query.eq("action", filter.action);
    }
    if (filter.targetType !== undefined) {
      query = query.eq("target_type", filter.targetType);
    }
    if (filter.targetId !== undefined) {
      query = query.eq("target_id", filter.targetId);
    }

    const result = await query.returns<
      {
        action: string;
        target_type: string | null;
        target_id: string | null;
        payload: Record<string, unknown>;
        actor: string;
        created_at: string;
      }[]
    >();

    if (result.error !== null) {
      throw new ConsoleError(`could not read the audit trail: ${result.error.message}`);
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

  alerts(limit: number): Promise<readonly AlertRow[]> {
    return alertStore().list(limit);
  }

  async health(): Promise<DeepHealth> {
    const startedAt = performance.now();
    let databaseOk = true;
    let databaseError: string | null = null;
    try {
      const probe = await supabase.from("matches").select("id", { count: "exact", head: true });
      if (probe.error !== null) {
        databaseOk = false;
        databaseError = probe.error.message;
      }
    } catch (error) {
      databaseOk = false;
      databaseError = error instanceof Error ? error.message : "unknown database error";
    }
    const latencyMs = Math.round(performance.now() - startedAt);

    const live = await supabase
      .from("matches")
      .select("id")
      .eq("status", "live")
      .returns<{ id: string }[]>();
    const liveIds = (live.data ?? []).map((row) => row.id);

    const repriced =
      liveIds.length === 0
        ? []
        : ((
            await supabase
              .from("markets")
              .select("match_id, updated_at")
              .in("match_id", liveIds)
              .order("updated_at", { ascending: false })
              .returns<{ match_id: string; updated_at: string }[]>()
          ).data ?? []);

    const lastByMatch = new Map<string, string>();
    for (const row of repriced) {
      if (!lastByMatch.has(row.match_id)) {
        lastByMatch.set(row.match_id, row.updated_at);
      }
    }

    const leases = await supabase
      .from("scheduler_leases")
      .select("*")
      .returns<Record<string, unknown>[]>();

    const openAlerts = await alertStore().openCount();

    return {
      ok: databaseOk,
      database: { ok: databaseOk, latencyMs, error: databaseError },
      liveMatches: liveIds.length,
      lastRepriceByMatch: liveIds.map((matchId) => ({
        matchId,
        at: lastByMatch.get(matchId) ?? null,
      })),
      scheduler: {
        leases: (leases.data ?? []).map((row) => ({
          name: String(row["name"] ?? row["key"] ?? row["id"] ?? "scheduler"),
          expiresAt:
            typeof row["expires_at"] === "string"
              ? row["expires_at"]
              : typeof row["locked_until"] === "string"
                ? row["locked_until"]
                : null,
        })),
      },
      workerPool: {
        cores: coreCount(),
        threadsPerPrice: Math.max(1, Math.min(8, coreCount() - 1)),
        mode: "workers",
      },
      alertsOpen: openAlerts,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}

/** The in-memory console: the routes and their tests share one interface. */
export class InMemoryAdminConsole implements AdminConsole {
  readonly #bots: BotView[] = [];
  readonly #actions: AdminAction[] = [];
  readonly #alerts: AlertRow[] = [];
  readonly #markets = new Map<string, string>();
  readonly #profiles = new Map<string, Record<string, unknown>>();
  readonly #overrides = new Map<string, MarketOverrideInput>();
  readonly #liveMatches: string[] = [];
  #paused = false;
  #exposureMinor = 0;
  #freeBankrollMinor = 0;

  constructor(
    seed: { readonly liveMatches?: readonly string[]; readonly freeBankrollMinor?: number } = {},
  ) {
    this.#liveMatches = [...(seed.liveMatches ?? [])];
    this.#freeBankrollMinor = seed.freeBankrollMinor ?? 0;
  }

  overview(): Promise<AdminOverview> {
    return Promise.resolve({
      currency: env.CURRENCY,
      liveMatches: this.#liveMatches.length,
      liveMatchIds: [...this.#liveMatches],
      openExposureMinor: this.#exposureMinor,
      exposureByMatch: this.#liveMatches.map((matchId) => ({
        matchId,
        exposureMinor: 0,
        openBets: 0,
      })),
      freeBankrollMinor: this.#freeBankrollMinor,
      pendingReviews: 0,
      flaggedMatches: 0,
      activeTournaments: 0,
      openAlerts: this.#alerts.length,
      bettingPaused: this.#paused,
      usersInSelfExclusion: [...this.#profiles.values()].filter(
        (profile) =>
          profile["self_excluded_until"] !== null && profile["self_excluded_until"] !== undefined,
      ).length,
    });
  }

  listBots(): Promise<readonly BotView[]> {
    const seen = new Set<string>();
    const latest: BotView[] = [];
    for (const bot of this.#bots) {
      if (!seen.has(bot.botId)) {
        seen.add(bot.botId);
        latest.push(bot);
      }
    }
    for (const level of BOT_LEVELS) {
      if (!latest.some((bot) => bot.botId === level)) {
        latest.push({ botId: level, level, numbers: null, updatedAt: null });
      }
    }
    return Promise.resolve(latest);
  }

  botHistory(botId: string): Promise<readonly BotView[]> {
    return Promise.resolve(this.#bots.filter((bot) => bot.botId === botId));
  }

  publishBot(input: PublishBotInput, actor: string): Promise<BotView> {
    const view: BotView = {
      botId: input.botId,
      level: input.level,
      numbers: input.numbers,
      updatedAt: new Date().toISOString(),
    };
    this.#bots.unshift(view);
    this.#actions.unshift({
      action: "bot.published",
      targetType: "bot",
      targetId: input.botId,
      payload: { numbers: input.numbers },
      actor,
      at: new Date().toISOString(),
    });
    return Promise.resolve(view);
  }

  suspendMarket(input: SuspendMarketInput, actor: string): Promise<number> {
    const key = `${input.matchId}:${input.marketType}:${input.subject ?? ""}`;
    this.#markets.set(key, input.suspended ? "suspended" : "open");
    this.#actions.unshift({
      action: input.suspended ? "market.suspended" : "market.resumed",
      targetType: "market",
      targetId: key,
      payload: {},
      actor,
      at: new Date().toISOString(),
    });
    return Promise.resolve(1);
  }

  setMarketOverride(input: MarketOverrideInput, actor: string): Promise<void> {
    this.#overrides.set(input.marketType, input);
    this.#actions.unshift({
      action: "market.override",
      targetType: "market_type",
      targetId: input.marketType,
      payload: { ...input },
      actor,
      at: new Date().toISOString(),
    });
    return Promise.resolve();
  }

  #profile(userId: string): Record<string, unknown> {
    const existing = this.#profiles.get(userId);
    if (existing !== undefined) {
      return existing;
    }
    const created: Record<string, unknown> = {};
    this.#profiles.set(userId, created);
    return created;
  }

  setSelfExclusion(userId: string, until: string | null, actor: string): Promise<void> {
    const profile = this.#profile(userId);
    profile["self_excluded_until"] = until;
    this.#actions.unshift({
      action: "user.self_exclusion",
      targetType: "user",
      targetId: userId,
      payload: { until },
      actor,
      at: new Date().toISOString(),
    });
    return Promise.resolve();
  }

  setKyc(
    userId: string,
    status: "none" | "pending" | "verified" | "rejected",
    actor: string,
  ): Promise<void> {
    this.#profile(userId)["kyc_status"] = status;
    this.#actions.unshift({
      action: "user.kyc",
      targetType: "user",
      targetId: userId,
      payload: { status },
      actor,
      at: new Date().toISOString(),
    });
    return Promise.resolve();
  }

  setFrozen(userId: string, frozen: boolean, actor: string): Promise<void> {
    this.#profile(userId)["frozen_until"] = frozen ? "frozen" : null;
    this.#actions.unshift({
      action: "user.frozen",
      targetType: "user",
      targetId: userId,
      payload: { frozen },
      actor,
      at: new Date().toISOString(),
    });
    return Promise.resolve();
  }

  auditLog(filter: AuditFilter): Promise<readonly AdminAction[]> {
    const filtered = this.#actions.filter(
      (entry) =>
        (filter.action === undefined || entry.action === filter.action) &&
        (filter.targetType === undefined || entry.targetType === filter.targetType) &&
        (filter.targetId === undefined || entry.targetId === filter.targetId),
    );
    return Promise.resolve(filtered.slice(0, filter.limit));
  }

  alerts(limit: number): Promise<readonly AlertRow[]> {
    return Promise.resolve(this.#alerts.slice(0, limit));
  }

  addAlert(row: AlertRow): void {
    this.#alerts.unshift(row);
  }

  setFreeBankrollMinor(value: number): void {
    this.#freeBankrollMinor = value;
  }

  health(): Promise<DeepHealth> {
    return Promise.resolve({
      ok: true,
      database: { ok: true, latencyMs: 1, error: null },
      liveMatches: this.#liveMatches.length,
      lastRepriceByMatch: this.#liveMatches.map((matchId) => ({ matchId, at: null })),
      scheduler: { leases: [] },
      workerPool: { cores: coreCount(), threadsPerPrice: 1, mode: "inline" },
      alertsOpen: this.#alerts.length,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }
}

/** The cores this process may use. A price takes all but one, at most eight. */
function coreCount(): number {
  return Math.max(1, cpus().length);
}

let consoleStore: AdminConsole | null = null;

/** The console in use: the database unless a test replaced it. */
export function adminConsole(): AdminConsole {
  consoleStore ??= new SupabaseAdminConsole();
  return consoleStore;
}

/** Replaces the console. Tests only; null restores the default. */
export function setAdminConsole(replacement: AdminConsole | null): void {
  consoleStore = replacement;
  logger.debug({}, "admin console replaced");
}

/** A unique id for an operator session's audit rows, used by tests. */
export function auditId(): string {
  return randomUUID();
}
