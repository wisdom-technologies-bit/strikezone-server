import { beforeEach, describe, expect, it } from "vitest";
import {
  accountOldEnough,
  assertMayDeposit,
  exclusionEnd,
  isExcluded,
  planLimitChange,
  PlayBlocked,
  resolveEffectiveLimits,
  selfExclude,
  updateLimits,
  type LimitsRepository,
  type LimitsRow,
  type PlayState,
  type UserLimits,
} from "../../src/betting/limits.js";

/**
 * Responsible play: the 24 hour rule, self-exclusion and the deposit gate.
 *
 * The rule that matters is asymmetric on purpose. A player can always tighten
 * now; loosening waits a day. These tests pin that asymmetry down, plus the two
 * ways money in is refused.
 */

const NO_LIMITS: UserLimits = {
  dailyDepositLimitMinor: null,
  dailyLossLimitMinor: null,
  maxStakeMinor: null,
};

class FakeLimits implements LimitsRepository {
  #row: LimitsRow = { limits: NO_LIMITS, pending: null };
  #state: PlayState = {
    selfExcludedUntil: null,
    selfExclusionKind: null,
    kycStatus: "verified",
    accountCreatedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
  };
  deposited = 0;

  getLimits(): Promise<LimitsRow> {
    return Promise.resolve(this.#row);
  }

  saveLimits(_userId: string, change: { immediate: UserLimits; pending: LimitsRow["pending"] }): Promise<void> {
    this.#row = { limits: change.immediate, pending: change.pending };
    return Promise.resolve();
  }

  getPlayState(): Promise<PlayState> {
    return Promise.resolve(this.#state);
  }

  setExclusion(
    _userId: string,
    until: string | null,
    kind: PlayState["selfExclusionKind"],
  ): Promise<void> {
    this.#state = { ...this.#state, selfExcludedUntil: until, selfExclusionKind: kind };
    return Promise.resolve();
  }

  dailyLossMinor(): Promise<number> {
    return Promise.resolve(0);
  }

  dailyDepositedMinor(): Promise<number> {
    return Promise.resolve(this.deposited);
  }

  /** Test seam: an old account, or a new one. */
  setAge(hours: number): void {
    this.#state = {
      ...this.#state,
      accountCreatedAt: new Date(Date.now() - hours * 3_600_000).toISOString(),
    };
  }
}

describe("limits", () => {
  let book: FakeLimits;

  beforeEach(() => {
    book = new FakeLimits();
  });

  it("applies a tightening immediately and holds a relaxation for 24 hours", () => {
    const at = new Date("2026-10-30T12:00:00.000Z");

    const tightened = planLimitChange(
      { limits: { ...NO_LIMITS, maxStakeMinor: 50_000 }, pending: null },
      { maxStakeMinor: 10_000 },
      at,
    );
    expect(tightened.immediate.maxStakeMinor).toBe(10_000);
    expect(tightened.pending).toBeNull();

    const relaxed = planLimitChange(
      { limits: { ...NO_LIMITS, maxStakeMinor: 50_000 }, pending: null },
      { maxStakeMinor: 80_000 },
      at,
    );
    expect(relaxed.immediate.maxStakeMinor).toBe(50_000);
    expect(relaxed.pending?.limits.maxStakeMinor).toBe(80_000);
    expect(relaxed.pending?.effectiveAt).toBe("2026-10-31T12:00:00.000Z");
  });

  it("treats setting a limit as a tightening and removing one as a relaxation", () => {
    const at = new Date("2026-10-30T12:00:00.000Z");

    const create = planLimitChange({ limits: NO_LIMITS, pending: null }, { dailyLossLimitMinor: 5_000 }, at);
    expect(create.immediate.dailyLossLimitMinor).toBe(5_000);
    expect(create.pending).toBeNull();

    const remove = planLimitChange(
      { limits: { ...NO_LIMITS, dailyLossLimitMinor: 5_000 }, pending: null },
      { dailyLossLimitMinor: null },
      at,
    );
    expect(remove.immediate.dailyLossLimitMinor).toBe(5_000);
    expect(remove.pending?.limits.dailyLossLimitMinor).toBeNull();
  });

  it("uses the pending limits only once they are due", () => {
    const row: LimitsRow = {
      limits: { ...NO_LIMITS, maxStakeMinor: 10_000 },
      pending: {
        limits: { ...NO_LIMITS, maxStakeMinor: 40_000 },
        effectiveAt: "2026-10-31T12:00:00.000Z",
      },
    };

    expect(resolveEffectiveLimits(row, new Date("2026-10-31T11:59:59.000Z")).maxStakeMinor).toBe(10_000);
    expect(resolveEffectiveLimits(row, new Date("2026-10-31T12:00:01.000Z")).maxStakeMinor).toBe(40_000);
  });

  it("stores a raised limit as pending and reports it", async () => {
    const at = new Date("2026-10-30T12:00:00.000Z");
    await book.saveLimits("user-1", {
      immediate: { ...NO_LIMITS, maxStakeMinor: 10_000 },
      pending: null,
    });

    const result = await updateLimits("user-1", { maxStakeMinor: 30_000 }, book, at);

    expect(result.effective.maxStakeMinor).toBe(10_000);
    expect(result.pending?.limits.maxStakeMinor).toBe(30_000);
    expect((await book.getLimits()).limits.maxStakeMinor).toBe(10_000);
  });

  it("ends an exclusion when it says it will", () => {
    const at = new Date("2026-10-30T12:00:00.000Z");
    expect(exclusionEnd(at, { hours: 24, kind: "self_exclusion" })).toBe("2026-10-31T12:00:00.000Z");
    expect(exclusionEnd(at, { hours: 1, kind: "cool_off" })).toBe("2026-10-30T13:00:00.000Z");
  });

  it("refuses a deposit from an excluded player", async () => {
    await selfExclude("user-1", { hours: 24, kind: "self_exclusion" }, book);

    await expect(assertMayDeposit("user-1", 1_000, book)).rejects.toBeInstanceOf(PlayBlocked);
    await expect(assertMayDeposit("user-1", 1_000, book)).rejects.toMatchObject({
      code: "self_excluded",
    });
  });

  it("refuses a deposit over the daily limit, counting what is already in", async () => {
    await book.saveLimits("user-1", {
      immediate: { ...NO_LIMITS, dailyDepositLimitMinor: 50_000 },
      pending: null,
    });

    book.deposited = 40_000;
    await expect(assertMayDeposit("user-1", 20_000, book)).rejects.toMatchObject({
      code: "daily_deposit_limit",
    });

    await expect(assertMayDeposit("user-1", 10_000, book)).resolves.toBeUndefined();
  });

  it("lets an exclusion lapse and reports it accurately", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const state: PlayState = {
      selfExcludedUntil: until,
      selfExclusionKind: "self_exclusion",
      kycStatus: "verified",
      accountCreatedAt: new Date().toISOString(),
    };

    expect(isExcluded(state, new Date())).toBe(true);
    expect(isExcluded(state, new Date(Date.now() + 2 * 3_600_000))).toBe(false);
    expect(isExcluded({ ...state, selfExcludedUntil: null }, new Date())).toBe(false);
  });

  it("knows how old an account is", () => {
    const at = new Date("2026-10-30T12:00:00.000Z");
    const state: PlayState = {
      selfExcludedUntil: null,
      selfExclusionKind: null,
      kycStatus: "verified",
      accountCreatedAt: "2026-10-29T12:00:00.000Z",
    };

    expect(accountOldEnough(state, at, 24)).toBe(true);
    expect(accountOldEnough(state, new Date("2026-10-30T11:00:00.000Z"), 24)).toBe(false);
  });
});
