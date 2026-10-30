import { beforeEach, describe, expect, it } from "vitest";
import { creditDeposit, handlePaymentWebhook, startDeposit } from "../../src/wallet/deposits.js";
import { InMemoryLedger } from "../../src/wallet/ledger.js";
import { InMemoryPaymentsRepository } from "../../src/wallet/payments-store.js";
import { MOCK_SIGNATURE_HEADER, MockProvider } from "../../src/wallet/providers/mock.js";
import { providerByName } from "../../src/wallet/providers/index.js";
import { ManualProvider } from "../../src/wallet/providers/manual.js";
import {
  approveWithdrawal,
  markWithdrawalPaid,
  rejectWithdrawal,
  requestWithdrawal,
  WithdrawalRefused,
} from "../../src/wallet/withdrawals.js";
import type { LimitsRepository, PlayState } from "../../src/betting/limits.js";

/**
 * Money in and money out.
 *
 * These tests are about the two things that go wrong with payments: charging
 * twice and paying twice. Every path here is idempotent by construction, and
 * each test asserts that a second attempt moves nothing.
 */

class VerifiedPlayers implements LimitsRepository {
  readonly #states = new Map<string, PlayState>();
  readonly #deposited = new Map<string, number>();

  constructor(userIds: readonly string[]) {
    for (const id of userIds) {
      this.#states.set(id, {
        selfExcludedUntil: null,
        selfExclusionKind: null,
        kycStatus: "verified",
        accountCreatedAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
      });
    }
  }

  getLimits(): Promise<{
    limits: { dailyDepositLimitMinor: null; dailyLossLimitMinor: null; maxStakeMinor: null };
    pending: null;
  }> {
    return Promise.resolve({
      limits: { dailyDepositLimitMinor: null, dailyLossLimitMinor: null, maxStakeMinor: null },
      pending: null,
    });
  }

  saveLimits(): Promise<void> {
    return Promise.resolve();
  }

  getPlayState(userId: string): Promise<PlayState | null> {
    return Promise.resolve(this.#states.get(userId) ?? null);
  }

  setExclusion(): Promise<void> {
    return Promise.resolve();
  }

  dailyLossMinor(): Promise<number> {
    return Promise.resolve(0);
  }

  dailyDepositedMinor(userId: string): Promise<number> {
    return Promise.resolve(this.#deposited.get(userId) ?? 0);
  }
}

/** The mock provider the webhook route resolves by name, typed for its signer. */
function mockProvider(): MockProvider {
  const provider = providerByName("mock");
  if (!(provider instanceof MockProvider)) {
    throw new Error("the mock provider is not registered");
  }
  return provider;
}

interface World {
  readonly ledger: InMemoryLedger;
  readonly payments: InMemoryPaymentsRepository;
  readonly limits: VerifiedPlayers;
  readonly provider: MockProvider;
}

async function world(userId = "user-1", funds = 100_000): Promise<World> {
  const ledger = new InMemoryLedger("NGN");
  await ledger.post({
    idempotencyKey: "topup",
    kind: "bankroll_topup",
    refType: "bankroll",
    refId: null,
    entries: [
      { accountId: await ledger.treasuryAccount(), amountMinor: -10_000_000 },
      { accountId: await ledger.houseAccount(), amountMinor: 10_000_000 },
    ],
  });
  await ledger.post({
    idempotencyKey: "fund",
    kind: "deposit",
    refType: "deposit",
    refId: null,
    entries: [
      { accountId: await ledger.treasuryAccount(), amountMinor: -funds },
      { accountId: await ledger.userAccount(userId), amountMinor: funds },
    ],
  });

  return {
    ledger,
    payments: new InMemoryPaymentsRepository(),
    limits: new VerifiedPlayers([userId]),
    // The same instance the webhook route resolves by name, so the signature is
    // checked against the secret the process actually signs with.
    provider: mockProvider(),
  };
}

describe("deposits", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("credits a deposit exactly once", async () => {
    const started = await startDeposit(
      "user-1",
      { amountMinor: 25_000 },
      { payments: w.payments, ledger: w.ledger, limits: w.limits, provider: w.provider },
    );

    expect(started.credited).toBe(true);
    expect(started.deposit.status).toBe("credited");
    expect(await w.ledger.balanceOf(await w.ledger.userAccount("user-1"))).toBe(125_000);

    await creditDeposit(started.deposit.id, {
      payments: w.payments,
      ledger: w.ledger,
    });

    expect(await w.ledger.balanceOf(await w.ledger.userAccount("user-1"))).toBe(125_000);
  });

  it("refuses a deposit for an excluded player before any row is written", async () => {
    const excluded = new (class extends VerifiedPlayers {
      override getPlayState(): Promise<PlayState> {
        return Promise.resolve({
          selfExcludedUntil: new Date(Date.now() + 3_600_000).toISOString(),
          selfExclusionKind: "self_exclusion",
          kycStatus: "verified",
          accountCreatedAt: new Date().toISOString(),
        });
      }
    })(["user-1"]);

    await expect(
      startDeposit(
        "user-1",
        { amountMinor: 1_000 },
        { payments: w.payments, ledger: w.ledger, limits: excluded, provider: w.provider },
      ),
    ).rejects.toMatchObject({ code: "self_excluded" });

    expect(w.payments.deposits()).toHaveLength(0);
  });

  it("credits a signed webhook once and refuses a replay", async () => {
    // A pending deposit, as a real provider would leave it before its webhook.
    const pending = await w.payments.createDeposit({
      userId: "user-1",
      provider: "mock",
      providerRef: "mock_ref_42",
      amountMinor: 5_000,
      currency: "NGN",
      status: "pending",
    });

    const body = JSON.stringify({
      eventId: "evt-1",
      kind: "deposit",
      providerRef: pending.providerRef,
      amountMinor: 5_000,
      status: "succeeded",
    });
    const headers = { [MOCK_SIGNATURE_HEADER]: w.provider.sign(body) };

    const first = await handlePaymentWebhook("mock", headers, body, {
      payments: w.payments,
      ledger: w.ledger,
    });
    expect(first.outcome).toBe("deposit_credited");

    const second = await handlePaymentWebhook("mock", headers, body, {
      payments: w.payments,
      ledger: w.ledger,
    });
    expect(second.duplicate).toBe(true);

    expect(await w.ledger.balanceOf(await w.ledger.userAccount("user-1"))).toBe(105_000);
  });

  it("refuses a webhook whose signature does not match", async () => {
    const body = JSON.stringify({
      eventId: "evt-2",
      kind: "deposit",
      providerRef: "mock_ref_1",
      amountMinor: 5_000,
      status: "succeeded",
    });

    const verdict = await handlePaymentWebhook(
      "mock",
      { [MOCK_SIGNATURE_HEADER]: "not-the-signature" },
      body,
      { payments: w.payments, ledger: w.ledger },
    );

    expect(verdict.accepted).toBe(false);
    expect(verdict.outcome).toBe("signature_rejected");
  });

  it("refuses a webhook that reports a different amount", async () => {
    const pending = await w.payments.createDeposit({
      userId: "user-1",
      provider: "mock",
      providerRef: "mock_ref_7",
      amountMinor: 5_000,
      currency: "NGN",
      status: "pending",
    });

    const body = JSON.stringify({
      eventId: "evt-3",
      kind: "deposit",
      providerRef: pending.providerRef,
      amountMinor: 50_000,
      status: "succeeded",
    });

    const outcome = await handlePaymentWebhook(
      "mock",
      { [MOCK_SIGNATURE_HEADER]: w.provider.sign(body) },
      body,
      { payments: w.payments, ledger: w.ledger },
    );

    expect(outcome.outcome).toBe("amount_mismatch");
    expect(await w.ledger.balanceOf(await w.ledger.userAccount("user-1"))).toBe(100_000);
  });

  it("never trusts a manual provider's webhook", async () => {
    const manual = new ManualProvider();
    const verdict = manual.verifyWebhook();
    expect(verdict.ok).toBe(false);
  });
});

describe("withdrawals", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("moves the money into the hold when it is requested", async () => {
    const withdrawal = await requestWithdrawal(
      "user-1",
      { amountMinor: 30_000, destination: "0123456789" },
      { payments: w.payments, ledger: w.ledger, limits: w.limits, provider: w.provider },
    );

    expect(withdrawal.status).toBe("requested");
    expect(await w.ledger.balanceOf(await w.ledger.userAccount("user-1"))).toBe(70_000);
    expect(await w.ledger.balanceOf(await w.ledger.withdrawalHoldAccount())).toBe(30_000);
  });

  it("approves without moving money, then pays it once", async () => {
    const withdrawal = await requestWithdrawal(
      "user-1",
      { amountMinor: 30_000 },
      { payments: w.payments, ledger: w.ledger, limits: w.limits, provider: w.provider },
    );

    await approveWithdrawal(withdrawal.id, "operator", { payments: w.payments });
    expect(await w.ledger.balanceOf(await w.ledger.withdrawalHoldAccount())).toBe(30_000);

    const paid = await markWithdrawalPaid(withdrawal.id, "operator", {
      payments: w.payments,
      ledger: w.ledger,
      provider: w.provider,
    });

    expect(paid.status).toBe("paid");
    expect(await w.ledger.balanceOf(await w.ledger.withdrawalHoldAccount())).toBe(0);
    // The treasury funded the book (-10,100,000) and received the paid-out 30,000.
    expect(await w.ledger.balanceOf(await w.ledger.treasuryAccount())).toBe(-10_070_000);
  });

  it("returns the money to the player when a withdrawal is rejected", async () => {
    const withdrawal = await requestWithdrawal(
      "user-1",
      { amountMinor: 30_000 },
      { payments: w.payments, ledger: w.ledger, limits: w.limits, provider: w.provider },
    );

    const rejected = await rejectWithdrawal(withdrawal.id, "operator", "wrong name", {
      payments: w.payments,
      ledger: w.ledger,
    });

    expect(rejected.status).toBe("rejected");
    expect(await w.ledger.balanceOf(await w.ledger.userAccount("user-1"))).toBe(100_000);
    expect(await w.ledger.balanceOf(await w.ledger.withdrawalHoldAccount())).toBe(0);
  });

  it("refuses to withdraw more than the wallet holds", async () => {
    await expect(
      requestWithdrawal(
        "user-1",
        { amountMinor: 500_000 },
        { payments: w.payments, ledger: w.ledger, limits: w.limits, provider: w.provider },
      ),
    ).rejects.toBeInstanceOf(WithdrawalRefused);
  });

  it("refuses a second decision on a settled withdrawal", async () => {
    const withdrawal = await requestWithdrawal(
      "user-1",
      { amountMinor: 10_000 },
      { payments: w.payments, ledger: w.ledger, limits: w.limits, provider: w.provider },
    );

    await markWithdrawalPaid(withdrawal.id, "operator", {
      payments: w.payments,
      ledger: w.ledger,
      provider: w.provider,
    });

    await expect(
      rejectWithdrawal(withdrawal.id, "operator", "late", {
        payments: w.payments,
        ledger: w.ledger,
      }),
    ).rejects.toMatchObject({ code: "wrong_status" });
  });
});
