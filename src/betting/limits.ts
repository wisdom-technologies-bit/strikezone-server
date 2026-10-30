import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";

/**
 * Responsible play: limits, self-exclusion and the cool-off.
 *
 * One rule shapes everything here: a player can tighten at any moment and can
 * only loosen after a delay. Tightening applies now; loosening waits
 * twenty-four hours, so a bad night cannot be undone in a bad minute. The
 * database applies the same rule in `effective_limits`, and this module is where
 * the wait is calculated.
 */

/** How long a relaxation waits. */
export const LIMIT_RELAXATION_HOURS = 24;

/** The longest a self-exclusion may run, so a typo cannot lock an account for years. */
export const MAX_EXCLUSION_DAYS = 365;

/** The limits in force. Null means the player has not set that limit. */
export interface UserLimits {
  readonly dailyDepositLimitMinor: number | null;
  readonly dailyLossLimitMinor: number | null;
  readonly maxStakeMinor: number | null;
}

/** A change waiting to take effect. */
export interface PendingLimits {
  readonly limits: UserLimits;
  readonly effectiveAt: string;
}

/** What the table holds for one player. */
export interface LimitsRow {
  readonly limits: UserLimits;
  readonly pending: PendingLimits | null;
}

export const limitsRequestSchema = z
  .strictObject({
    dailyDepositLimitMinor: z.number().int().min(0).nullable().optional(),
    dailyLossLimitMinor: z.number().int().min(0).nullable().optional(),
    maxStakeMinor: z.number().int().min(0).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "no limits were given" });

export type LimitsRequest = z.infer<typeof limitsRequestSchema>;

export const selfExclusionRequestSchema = z
  .strictObject({
    /** How long the exclusion runs, in hours. One to 8,760. */
    hours: z.number().int().min(1).max(MAX_EXCLUSION_DAYS * 24),
    /** self_exclusion is the full block; cool_off is the same block, short. */
    kind: z.enum(["self_exclusion", "cool_off"]).default("self_exclusion"),
  })
  .strict();

export type SelfExclusionRequest = z.infer<typeof selfExclusionRequestSchema>;

/** The limits actually in force at a moment, given what may be pending. */
export function resolveEffectiveLimits(row: LimitsRow, at: Date): UserLimits {
  if (row.pending !== null && Date.parse(row.pending.effectiveAt) <= at.getTime()) {
    return row.pending.limits;
  }
  return row.limits;
}

/** A change to the stored limits: what applies now, and what waits. */
export interface LimitsChange {
  readonly immediate: UserLimits;
  readonly pending: PendingLimits | null;
}

/**
 * Works out what a requested change means.
 *
 * A field that moves down (or stays put) applies immediately. A field that moves
 * up is held with the rest of the request, and every held field lands together
 * when the wait is over.
 */
export function planLimitChange(
  current: LimitsRow,
  requested: LimitsRequest,
  at: Date,
  relaxationHours: number = LIMIT_RELAXATION_HOURS,
): LimitsChange {
  const effective = resolveEffectiveLimits(current, at);
  const merged: Record<keyof UserLimits, number | null> = { ...effective };

  const raised: Partial<Record<keyof UserLimits, number | null>> = {};
  let anyRaised = false;

  const fields: (keyof UserLimits)[] = [
    "dailyDepositLimitMinor",
    "dailyLossLimitMinor",
    "maxStakeMinor",
  ];

  for (const field of fields) {
    const wanted = requested[field];
    if (wanted === undefined) {
      continue;
    }
    const now = effective[field];
    // Null is no limit, so setting one tightens and removing one loosens. The
    // first branch used to be inverted, which let a new limit wait 24 hours.
    const loosens = now === null ? false : wanted === null || wanted > now;
    if (loosens) {
      raised[field] = wanted;
      anyRaised = true;
    } else {
      merged[field] = wanted;
    }
  }

  const immediate: UserLimits = {
    dailyDepositLimitMinor: merged.dailyDepositLimitMinor,
    dailyLossLimitMinor: merged.dailyLossLimitMinor,
    maxStakeMinor: merged.maxStakeMinor,
  };

  if (!anyRaised) {
    return { immediate, pending: null };
  }

  const effectiveAt = new Date(at.getTime() + relaxationHours * 3_600_000).toISOString();

  return {
    immediate,
    pending: {
      limits: {
        dailyDepositLimitMinor:
          raised.dailyDepositLimitMinor === undefined
            ? immediate.dailyDepositLimitMinor
            : raised.dailyDepositLimitMinor,
        dailyLossLimitMinor:
          raised.dailyLossLimitMinor === undefined
            ? immediate.dailyLossLimitMinor
            : raised.dailyLossLimitMinor,
        maxStakeMinor:
          raised.maxStakeMinor === undefined ? immediate.maxStakeMinor : raised.maxStakeMinor,
      },
      effectiveAt,
    },
  };
}

/** When a self-exclusion asked for now ends. */
export function exclusionEnd(at: Date, request: SelfExclusionRequest): string {
  return new Date(at.getTime() + request.hours * 3_600_000).toISOString();
}

/** A player's responsible-play state, as the money paths need it. */
export interface PlayState {
  readonly selfExcludedUntil: string | null;
  readonly selfExclusionKind: "self_exclusion" | "cool_off" | null;
  readonly kycStatus: "none" | "pending" | "verified" | "rejected";
  readonly accountCreatedAt: string;
}

/** Everything the limits need from storage. */
export interface LimitsRepository {
  getLimits(userId: string): Promise<LimitsRow>;
  saveLimits(userId: string, change: LimitsChange): Promise<void>;
  getPlayState(userId: string): Promise<PlayState | null>;
  setExclusion(
    userId: string,
    until: string | null,
    kind: "self_exclusion" | "cool_off" | null,
  ): Promise<void>;
  /** Stakes lost today, for the daily loss limit. */
  dailyLossMinor(userId: string, at: Date): Promise<number>;
  /** Deposits credited today, for the daily deposit limit. */
  dailyDepositedMinor(userId: string, at: Date): Promise<number>;
}

/** Raised when responsible play refuses an action. */
export class PlayBlocked extends Error {
  readonly code: "self_excluded" | "daily_deposit_limit" | "kyc_required" | "account_too_new";
  readonly details: Readonly<Record<string, string | number | null>>;

  constructor(
    code: PlayBlocked["code"],
    details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super(`play blocked: ${code}`);
    this.name = "PlayBlocked";
    this.code = code;
    this.details = details;
  }
}

/** True when an exclusion is running at a moment. */
export function isExcluded(state: PlayState, at: Date): boolean {
  if (state.selfExcludedUntil === null) {
    return false;
  }
  return Date.parse(state.selfExcludedUntil) > at.getTime();
}

/**
 * The deposit gate: an excluded player cannot put money in, and the daily
 * deposit limit is measured against what has already been credited today.
 */
export async function assertMayDeposit(
  userId: string,
  amountMinor: number,
  repository: LimitsRepository,
  at: Date = new Date(),
): Promise<void> {
  const state = await repository.getPlayState(userId);
  if (state === null) {
    throw new PlayBlocked("kyc_required", { reason: "no such player" });
  }

  if (isExcluded(state, at)) {
    throw new PlayBlocked("self_excluded", { until: state.selfExcludedUntil });
  }

  const limits = resolveEffectiveLimits(await repository.getLimits(userId), at);
  if (limits.dailyDepositLimitMinor === null) {
    return;
  }

  const already = await repository.dailyDepositedMinor(userId, at);
  if (already + amountMinor > limits.dailyDepositLimitMinor) {
    throw new PlayBlocked("daily_deposit_limit", {
      limitMinor: limits.dailyDepositLimitMinor,
      alreadyMinor: already,
    });
  }
}

/** True when the account is old enough to withdraw, in real money. */
export function accountOldEnough(
  state: PlayState,
  at: Date,
  minimumHours: number = env.MIN_ACCOUNT_AGE_HOURS,
): boolean {
  const ageHours = (at.getTime() - Date.parse(state.accountCreatedAt)) / 3_600_000;
  return ageHours >= minimumHours;
}

interface LimitsRowShape {
  daily_deposit_limit_minor: number | string | null;
  daily_loss_limit_minor: number | string | null;
  max_stake_minor: number | string | null;
  pending_daily_deposit_limit_minor: number | string | null;
  pending_daily_loss_limit_minor: number | string | null;
  pending_max_stake_minor: number | string | null;
  pending_effective_at: string | null;
}

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

export class SupabaseLimitsRepository implements LimitsRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async getLimits(userId: string): Promise<LimitsRow> {
    const result = await this.#client
      .from("user_limits")
      .select(
        "daily_deposit_limit_minor, daily_loss_limit_minor, max_stake_minor, pending_daily_deposit_limit_minor, pending_daily_loss_limit_minor, pending_max_stake_minor, pending_effective_at",
      )
      .eq("user_id", userId)
      .maybeSingle<LimitsRowShape>();

    if (result.error !== null) {
      throw new Error(`could not read the limits: ${result.error.message}`);
    }
    if (result.data === null) {
      return {
        limits: { dailyDepositLimitMinor: null, dailyLossLimitMinor: null, maxStakeMinor: null },
        pending: null,
      };
    }

    const row = result.data;
    return {
      limits: {
        dailyDepositLimitMinor: numberOrNull(row.daily_deposit_limit_minor),
        dailyLossLimitMinor: numberOrNull(row.daily_loss_limit_minor),
        maxStakeMinor: numberOrNull(row.max_stake_minor),
      },
      pending:
        row.pending_effective_at === null
          ? null
          : {
              limits: {
                dailyDepositLimitMinor: numberOrNull(row.pending_daily_deposit_limit_minor),
                dailyLossLimitMinor: numberOrNull(row.pending_daily_loss_limit_minor),
                maxStakeMinor: numberOrNull(row.pending_max_stake_minor),
              },
              effectiveAt: row.pending_effective_at,
            },
    };
  }

  async saveLimits(userId: string, change: LimitsChange): Promise<void> {
    const result = await this.#client.from("user_limits").upsert(
      {
        user_id: userId,
        daily_deposit_limit_minor: change.immediate.dailyDepositLimitMinor,
        daily_loss_limit_minor: change.immediate.dailyLossLimitMinor,
        max_stake_minor: change.immediate.maxStakeMinor,
        pending_daily_deposit_limit_minor: change.pending?.limits.dailyDepositLimitMinor ?? null,
        pending_daily_loss_limit_minor: change.pending?.limits.dailyLossLimitMinor ?? null,
        pending_max_stake_minor: change.pending?.limits.maxStakeMinor ?? null,
        pending_effective_at: change.pending?.effectiveAt ?? null,
      },
      { onConflict: "user_id" },
    );

    if (result.error !== null) {
      throw new Error(`could not save the limits: ${result.error.message}`);
    }
  }

  async getPlayState(userId: string): Promise<PlayState | null> {
    const result = await this.#client
      .from("profiles")
      .select("self_excluded_until, self_exclusion_kind, kyc_status, created_at")
      .eq("id", userId)
      .maybeSingle<{
        self_excluded_until: string | null;
        self_exclusion_kind: string | null;
        kyc_status: PlayState["kycStatus"];
        created_at: string;
      }>();

    if (result.error !== null) {
      throw new Error(`could not read the player: ${result.error.message}`);
    }
    if (result.data === null) {
      return null;
    }

    return {
      selfExcludedUntil: result.data.self_excluded_until,
      selfExclusionKind: (result.data.self_exclusion_kind ?? null) as PlayState["selfExclusionKind"],
      kycStatus: result.data.kyc_status,
      accountCreatedAt: result.data.created_at,
    };
  }

  async setExclusion(
    userId: string,
    until: string | null,
    kind: "self_exclusion" | "cool_off" | null,
  ): Promise<void> {
    const result = await this.#client
      .from("profiles")
      .update({ self_excluded_until: until, self_exclusion_kind: kind })
      .eq("id", userId);

    if (result.error !== null) {
      throw new Error(`could not save the exclusion: ${result.error.message}`);
    }
  }

  async dailyLossMinor(userId: string, at: Date): Promise<number> {
    const result = await this.#client.rpc("daily_loss_minor", {
      p_user_id: userId,
      p_at: at.toISOString(),
    });
    if (result.error !== null) {
      throw new Error(`could not read today's losses: ${result.error.message}`);
    }
    return Number(result.data ?? 0);
  }

  async dailyDepositedMinor(userId: string, at: Date): Promise<number> {
    const result = await this.#client.rpc("daily_deposited_minor", {
      p_user_id: userId,
      p_at: at.toISOString(),
    });
    if (result.error !== null) {
      throw new Error(`could not read today's deposits: ${result.error.message}`);
    }
    return Number(result.data ?? 0);
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let override: LimitsRepository | null = null;
let supabaseLimits: LimitsRepository | null = null;

export function limitsRepository(): LimitsRepository {
  if (override !== null) {
    return override;
  }
  supabaseLimits ??= new SupabaseLimitsRepository();
  return supabaseLimits;
}

export function setLimitsRepository(replacement: LimitsRepository | null): void {
  override = replacement;
}

/** Applies a limits request and returns what will be in force, and from when. */
export async function updateLimits(
  userId: string,
  request: LimitsRequest,
  repository: LimitsRepository,
  at: Date = new Date(),
): Promise<{ readonly effective: UserLimits; readonly pending: PendingLimits | null }> {
  const current = await repository.getLimits(userId);
  const change = planLimitChange(current, request, at);
  await repository.saveLimits(userId, change);
  return {
    effective: change.pending === null ? change.immediate : resolveEffectiveLimits(current, at),
    pending: change.pending,
  };
}

/** Starts or clears a self-exclusion. */
export async function selfExclude(
  userId: string,
  request: SelfExclusionRequest,
  repository: LimitsRepository,
  at: Date = new Date(),
): Promise<{ readonly until: string; readonly kind: "self_exclusion" | "cool_off" }> {
  const until = exclusionEnd(at, request);
  await repository.setExclusion(userId, until, request.kind);
  return { until, kind: request.kind };
}
