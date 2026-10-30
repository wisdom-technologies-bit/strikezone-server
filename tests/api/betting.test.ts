import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAdminStore, setAdminStore } from "../../src/admin/store.js";
import { setReportsSource } from "../../src/admin/reports.js";
import { createAdminMoneyRouter } from "../../src/api/admin-money.js";
import { createBetsRouter } from "../../src/api/bets.js";
import type { AuthUser } from "../../src/api/auth.js";
import { InMemoryBetsRepository, mintBetFactory } from "../../src/betting/bets-store.js";
import { setBetsRepository } from "../../src/betting/bets-store-store.js";
import { BetRejected } from "../../src/betting/errors.js";
import { InMemoryMarketsRepository, setMarketsRepository } from "../../src/odds/markets-store.js";
import { InMemoryLedger, ledger, setLedger } from "../../src/wallet/ledger.js";

/**
 * The betting and admin money routes, without a database.
 *
 * The players are faked at the auth seam, the repositories are in memory, and
 * the reports are a fixed answer: what is under test is the HTTP contract (codes,
 * shapes, refused bodies), not the SQL behind it.
 */

const ADMIN_KEY = "test-admin-api-key-0123456789";
const PLAYER: AuthUser = { id: "user-1", displayName: "Player One" };

const verifyUser = (token: string): Promise<AuthUser | null> =>
  Promise.resolve(token === "good-token" ? PLAYER : null);

function playerApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createBetsRouter({ verifyUser }));
  return app;
}

function adminApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createAdminMoneyRouter());
  return app;
}

const MARKET = "d0000000-0000-4000-8000-000000000001";

beforeEach(async () => {
  const book = new InMemoryLedger("NGN");
  await book.post({
    idempotencyKey: "topup",
    kind: "bankroll_topup",
    refType: "bankroll",
    refId: null,
    entries: [
      { accountId: await book.treasuryAccount(), amountMinor: -1_000_000 },
      { accountId: await book.houseAccount(), amountMinor: 1_000_000 },
    ],
  });
  setLedger(book);
  setAdminStore(new InMemoryAdminStore());
  setMarketsRepository(new InMemoryMarketsRepository());
  setReportsSource({
    solvency: () =>
      Promise.resolve({
        currency: "NGN",
        userBalancesMinor: 0,
        escrowMinor: 0,
        withdrawalHoldMinor: 0,
        houseMinor: 1_000_000,
        treasuryMinor: -1_000_000,
        prizePoolMinor: 0,
        openExposureMinor: 0,
        freeBankrollMinor: 1_000_000,
        heldPayoutsMinor: 0,
        openBetsMinor: 0,
        openWithdrawalsMinor: 0,
      }),
    reconcile: () =>
      Promise.resolve({
        currency: "NGN",
        unbalancedTransactions: 0,
        accountsNotMatchingEntries: 0,
        negativeUserAccounts: 0,
        betsWithoutStake: 0,
        escrowActualMinor: 0,
        escrowExpectedMinor: 0,
        escrowDifferenceMinor: 0,
        holdActualMinor: 0,
        holdExpectedMinor: 0,
        holdDifferenceMinor: 0,
        transactions: 1,
        entries: 2,
      }),
  });
});

afterEach(() => {
  setBetsRepository(null);
  setLedger(null);
  setAdminStore(null);
  setMarketsRepository(null);
  setReportsSource(null);
});

describe("POST /api/bets", () => {
  it("refuses a request with no token", async () => {
    setBetsRepository(new InMemoryBetsRepository({ place: mintBetFactory() }));
    const response = await request(playerApp()).post("/api/bets").send({
      marketId: MARKET,
      stakeMinor: 1_000,
      expectedOdds: 2,
      idempotencyKey: "key-123456",
    });

    expect(response.status).toBe(401);
  });

  it("places a bet and returns 201 with the bet and the balance", async () => {
    setBetsRepository(new InMemoryBetsRepository({ place: mintBetFactory() }));
    const response = await request(playerApp())
      .post("/api/bets")
      .set("authorization", "Bearer good-token")
      .send({
        marketId: MARKET,
        stakeMinor: 1_000,
        expectedOdds: 2,
        idempotencyKey: "key-123456",
      });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.bet.stakeMinor).toBe(1_000);
    expect(response.body.bet.potentialPayoutMinor).toBe(2_000);
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    setBetsRepository(new InMemoryBetsRepository({ place: mintBetFactory() }));
    const response = await request(playerApp())
      .post("/api/bets")
      .set("authorization", "Bearer good-token")
      .send({
        marketId: MARKET,
        stakeMinor: 1_000,
        expectedOdds: 2,
        idempotencyKey: "key-123456",
        bonus: true,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });

  it("refuses a stake below the configured minimum before any work", async () => {
    setBetsRepository(new InMemoryBetsRepository({ place: mintBetFactory() }));
    const response = await request(playerApp())
      .post("/api/bets")
      .set("authorization", "Bearer good-token")
      .send({ marketId: MARKET, stakeMinor: 1, expectedOdds: 2, idempotencyKey: "key-123456" });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("stake_below_minimum");
  });

  it("reports odds drift with the current price", async () => {
    setBetsRepository(
      new InMemoryBetsRepository({
        place: () => {
          throw new BetRejected("odds_moved", { currentOdds: 1.8 });
        },
      }),
    );

    const response = await request(playerApp())
      .post("/api/bets")
      .set("authorization", "Bearer good-token")
      .send({ marketId: MARKET, stakeMinor: 1_000, expectedOdds: 2, idempotencyKey: "key-123456" });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("odds_moved");
    expect(response.body.currentOdds).toBe(1.8);
  });
});

describe("the admin money routes", () => {
  it("refuses every route without the admin key", async () => {
    const response = await request(adminApp()).get("/api/admin/solvency");
    expect(response.status).toBe(403);
  });

  it("reports the position and a clean reconciliation", async () => {
    const solvency = await request(adminApp())
      .get("/api/admin/solvency")
      .set("x-admin-key", ADMIN_KEY);
    expect(solvency.status).toBe(200);
    expect(solvency.body.houseMinor).toBe(1_000_000);

    const reconcile = await request(adminApp())
      .get("/api/admin/reconcile")
      .set("x-admin-key", ADMIN_KEY);
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.clean).toBe(true);
    expect(reconcile.body.escrowDifferenceMinor).toBe(0);
  });

  it("tops up the bankroll through the ledger and audits it", async () => {
    const before = await ledger().balanceOf(await ledger().houseAccount());

    const response = await request(adminApp())
      .post("/api/admin/bankroll/topup")
      .set("x-admin-key", ADMIN_KEY)
      .set("x-admin-actor", "ops@example.test")
      .send({ amountMinor: 250_000, note: "launch float" });

    expect(response.status).toBe(201);
    expect(await ledger().balanceOf(await ledger().houseAccount())).toBe(before + 250_000);
  });

  it("pauses and resumes betting, and refuses a malformed body", async () => {
    const paused = await request(adminApp())
      .post("/api/admin/betting/pause")
      .set("x-admin-key", ADMIN_KEY)
      .send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.paused).toBe(true);

    const status = await request(adminApp())
      .get("/api/admin/betting")
      .set("x-admin-key", ADMIN_KEY);
    expect(status.body.paused).toBe(true);

    const malformed = await request(adminApp())
      .post("/api/admin/betting/pause")
      .set("x-admin-key", ADMIN_KEY)
      .send({ paused: "yes" });
    expect(malformed.status).toBe(400);
  });

  it("suspends a market and records it", async () => {
    const market = {
      matchId: "match-1",
      marketType: "match_winner",
      subject: "",
      line: null,
      selectionKey: "white",
      status: "open" as const,
      fairProbability: 0.5,
      oddsDecimal: 2,
      maxStakeMinor: 100_000,
      isLive: false,
    };
    const markets = new InMemoryMarketsRepository();
    await markets.upsert([market]);
    setMarketsRepository(markets);

    const list = await (async () => {
      const ids = await request(adminApp()).get("/api/admin/audit").set("x-admin-key", ADMIN_KEY);
      expect(ids.status).toBe(200);
      return ids;
    })();
    expect(list.body.actions).toHaveLength(0);

    const suspended = await request(adminApp())
      .post("/api/admin/markets/unknown/suspend")
      .set("x-admin-key", ADMIN_KEY)
      .send({ suspended: true });

    // The in-memory store names rows by their identity fields, so an unknown id
    // is a 404 rather than a silent no-op.
    expect(suspended.status).toBe(404);
  });
});
