import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryLedger, LedgerError } from "../../src/wallet/ledger.js";

/**
 * The ledger's rules, exercised in memory. The Supabase implementation leans on
 * `post_ledger_transaction` for exactly these checks, and
 * supabase/tests/verify.sql proves the SQL side separately.
 */
describe("the wallet ledger", () => {
  let book: InMemoryLedger;
  let house: string;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    book = new InMemoryLedger("XTS");
    house = await book.houseAccount();
    alice = await book.userAccount("profile-alice");
    bob = await book.userAccount("profile-bob");
  });

  it("posts a balanced transaction and moves both balances", async () => {
    await book.post({
      idempotencyKey: "seed-alice",
      kind: "deposit",
      entries: [
        { accountId: house, amountMinor: -10_000 },
        { accountId: alice, amountMinor: 10_000 },
      ],
    });

    expect(await book.balanceOf(alice)).toBe(10_000);
    expect(await book.balanceOf(house)).toBe(-10_000);

    await book.post({
      idempotencyKey: "alice-to-bob",
      kind: "adjustment",
      refType: "test",
      refId: "1",
      entries: [
        { accountId: alice, amountMinor: -2_500 },
        { accountId: bob, amountMinor: 2_500 },
      ],
    });

    expect(await book.balanceOf(alice)).toBe(7_500);
    expect(await book.balanceOf(bob)).toBe(2_500);
  });

  it("refuses legs that do not sum to zero", async () => {
    await expect(
      book.post({
        idempotencyKey: "unbalanced",
        kind: "adjustment",
        entries: [
          { accountId: house, amountMinor: -100 },
          { accountId: alice, amountMinor: 99 },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);

    expect(await book.balanceOf(alice)).toBe(0);
  });

  it("refuses floating point money, zero legs and a repeated account", async () => {
    await expect(
      book.post({
        idempotencyKey: "float",
        kind: "adjustment",
        entries: [
          { accountId: house, amountMinor: -100.5 },
          { accountId: alice, amountMinor: 100.5 },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);

    await expect(
      book.post({
        idempotencyKey: "zero",
        kind: "adjustment",
        entries: [
          { accountId: house, amountMinor: 0 },
          { accountId: alice, amountMinor: 0 },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);

    await expect(
      book.post({
        idempotencyKey: "twice",
        kind: "adjustment",
        entries: [
          { accountId: alice, amountMinor: 100 },
          { accountId: alice, amountMinor: -100 },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it("returns the original transaction for a repeated idempotency key", async () => {
    const input = {
      idempotencyKey: "once-only",
      kind: "deposit" as const,
      entries: [
        { accountId: house, amountMinor: -1_000 },
        { accountId: alice, amountMinor: 1_000 },
      ],
    };

    const first = await book.post(input);
    const second = await book.post(input);

    expect(second.id).toBe(first.id);
    expect(await book.balanceOf(alice)).toBe(1_000);
  });

  it("refuses to take a user account below zero", async () => {
    await expect(
      book.post({
        idempotencyKey: "overdraft",
        kind: "withdrawal",
        entries: [
          { accountId: alice, amountMinor: -1 },
          { accountId: house, amountMinor: 1 },
        ],
      }),
    ).rejects.toThrow(/below zero/);

    expect(await book.balanceOf(alice)).toBe(0);
  });

  it("refuses to take a prize pool below zero", async () => {
    const pool = await book.prizePoolAccount("tournament-1");

    await expect(
      book.post({
        idempotencyKey: "empty-pool",
        kind: "tournament_prize",
        entries: [
          { accountId: pool, amountMinor: -500 },
          { accountId: alice, amountMinor: 500 },
        ],
      }),
    ).rejects.toThrow(/below zero/);
  });

  it("keeps one account per owner: two calls return the same ids", async () => {
    expect(await book.userAccount("profile-alice")).toBe(alice);
    expect(await book.houseAccount()).toBe(house);

    const one = await book.prizePoolAccount("tournament-1");
    const two = await book.prizePoolAccount("tournament-1");
    expect(two).toBe(one);
    expect(await book.prizePoolAccount("tournament-2")).not.toBe(one);
  });

  it("records entries in order so a balance can always be audited", async () => {
    await book.post({
      idempotencyKey: "audit",
      kind: "deposit",
      entries: [
        { accountId: house, amountMinor: -400 },
        { accountId: alice, amountMinor: 400 },
      ],
    });

    const entries = await book.entriesFor(alice);
    expect(entries).toEqual([{ accountId: alice, amountMinor: 400 }]);
  });
});
