import express, { type Express } from "express";
import request from "supertest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

/**
 * A player who has just signed up, before any money has moved.
 *
 * They have a profile and nothing else: no wallet_accounts row, no bets, no
 * transactions, no limits row. Every read below must answer normally, and none of
 * them may create the account - the first deposit or stake does that.
 *
 * The database is a chainable stub: each builder method returns the builder and
 * awaiting it resolves the table's configured result. `insert` only counts, so a
 * read that tried to write would fail the assertion at the end of each test.
 */

interface TableResult {
  readonly data: unknown;
  readonly error: { readonly message: string } | null;
}

const fake = vi.hoisted(() => {
  const results: Record<string, TableResult> = {};
  const tables: string[] = [];
  let insertCalls = 0;
  const empty: TableResult = { data: null, error: null };

  const chainFor = (table: string): Record<string, unknown> => {
    const settle = (): Promise<TableResult> => Promise.resolve(results[table] ?? empty);
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "order", "limit", "lt"]) {
      builder[name] = () => builder;
    }
    builder.maybeSingle = settle;
    builder.returns = settle;
    builder.then = (
      onValue: (value: TableResult) => unknown,
      onError: (reason: unknown) => unknown,
    ) => settle().then(onValue, onError);
    builder.insert = () => {
      insertCalls += 1;
      return builder;
    };
    return builder;
  };

  return {
    results,
    tables,
    empty,
    inserts: (): number => insertCalls,
    reset: (): void => {
      for (const key of Object.keys(results)) delete results[key];
      tables.length = 0;
      insertCalls = 0;
    },
    set: (table: string, result: TableResult): void => {
      results[table] = result;
    },
    client: {
      from: (table: string) => {
        tables.push(table);
        return chainFor(table);
      },
    },
  };
});

vi.mock("../../src/lib/supabase.js", () => ({ supabase: fake.client }));

const { publicQueries, setPublicQueries } = await import("../../src/public/queries.js");
const { createPublicRouter } = await import("../../src/api/public.js");
const { SupabaseLimitsRepository } = await import("../../src/betting/limits.js");
const { ledgerCurrency } = await import("../../src/wallet/payments.js");

const USER = { id: "33333333-3333-4333-8333-333333333333", displayName: "Ada" };
const client = fake.client as unknown as SupabaseClient;

function appWithRealQueries(): Express {
  const app = express();
  app.use(express.json());
  app.use(
    createPublicRouter({
      verifyUser: (token: string) => Promise.resolve(token === "good-token" ? USER : null),
    }),
  );
  return app;
}

describe("a player with a profile and no wallet account", () => {
  it("reads an all-zero wallet", async () => {
    fake.reset();
    setPublicQueries(null);

    const wallet = await publicQueries().wallet(USER.id);

    expect(wallet).toEqual({
      currency: ledgerCurrency(),
      availableMinor: 0,
      atRiskMinor: 0,
      pendingWithdrawalMinor: 0,
      totalBalanceMinor: 0,
    });
  });

  it("reads an empty ledger page rather than an error", async () => {
    fake.reset();
    setPublicQueries(null);

    const page = await publicQueries().transactions(USER.id, { limit: 20 });

    expect(page.transactions).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.currency).toBe(ledgerCurrency());
  });

  it("reads the default limits with nothing pending", async () => {
    fake.reset();

    const row = await new SupabaseLimitsRepository(client).getLimits(USER.id);

    expect(row).toEqual({
      limits: { dailyDepositLimitMinor: null, dailyLossLimitMinor: null, maxStakeMinor: null },
      pending: null,
    });
  });

  it("opens no account, for any of the three reads", async () => {
    fake.reset();
    setPublicQueries(null);

    await publicQueries().wallet(USER.id);
    await publicQueries().transactions(USER.id, { limit: 20 });
    await new SupabaseLimitsRepository(client).getLimits(USER.id);

    expect(fake.inserts()).toBe(0);
  });
});

describe("a player who has deposited before", () => {
  it("keeps their real balance, stake at risk and pending withdrawal", async () => {
    fake.reset();
    setPublicQueries(null);
    fake.set("wallet_accounts", { data: { id: "acct-1" }, error: null });
    fake.set("account_balances", { data: { balance_minor: 25_000 }, error: null });
    fake.set("bets", { data: [{ stake_minor: 600 }, { stake_minor: 400 }], error: null });
    fake.set("withdrawals", { data: [{ amount_minor: 5_000 }], error: null });

    const wallet = await publicQueries().wallet(USER.id);

    expect(wallet).toEqual({
      currency: ledgerCurrency(),
      availableMinor: 25_000,
      atRiskMinor: 1_000,
      pendingWithdrawalMinor: 5_000,
      totalBalanceMinor: 31_000,
    });
    expect(fake.inserts()).toBe(0);
  });

  it("reads their ledger with a running balance", async () => {
    fake.reset();
    setPublicQueries(null);
    fake.set("wallet_accounts", { data: { id: "acct-1" }, error: null });
    fake.set("account_balances", { data: { balance_minor: 25_000 }, error: null });
    fake.set("ledger_entries", {
      data: [
        {
          id: "e1",
          amount_minor: -1_000,
          created_at: "2026-10-30T09:00:00.000Z",
          transaction_id: "t1",
          ledger_transactions: { kind: "bet_stake", ref_type: "bet", ref_id: "b1" },
        },
        {
          id: "e2",
          amount_minor: 26_000,
          created_at: "2026-10-29T09:00:00.000Z",
          transaction_id: "t2",
          ledger_transactions: { kind: "deposit", ref_type: null, ref_id: null },
        },
      ],
      error: null,
    });

    const page = await publicQueries().transactions(USER.id, { limit: 20 });

    expect(page.transactions).toHaveLength(2);
    expect(page.transactions[0]?.amountMinor).toBe(-1_000);
    expect(page.transactions[0]?.balanceAfterMinor).toBe(25_000);
    expect(page.transactions[1]?.balanceAfterMinor).toBe(26_000);
    expect(page.nextCursor).toBeNull();
  });
});

describe("a genuine database failure", () => {
  it("still answers 503 read_unavailable on the wallet route", async () => {
    fake.reset();
    setPublicQueries(null);
    fake.set("wallet_accounts", { data: null, error: { message: "connection reset" } });

    const response = await request(appWithRealQueries())
      .get("/api/me/wallet")
      .set("authorization", "Bearer good-token");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: "read_unavailable" });
  });

  it("still answers 503 read_unavailable on the transactions route", async () => {
    fake.reset();
    setPublicQueries(null);
    fake.set("wallet_accounts", { data: null, error: { message: "connection reset" } });

    const response = await request(appWithRealQueries())
      .get("/api/me/transactions")
      .set("authorization", "Bearer good-token");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: "read_unavailable" });
  });

  it("answers 200 with zeros for a new player over HTTP", async () => {
    fake.reset();
    setPublicQueries(null);

    const response = await request(appWithRealQueries())
      .get("/api/me/wallet")
      .set("authorization", "Bearer good-token");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, availableMinor: 0, atRiskMinor: 0 });
  });
});
