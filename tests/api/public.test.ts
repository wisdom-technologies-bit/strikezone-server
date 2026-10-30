import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configSchema,
  leaderboardResponseSchema,
  matchesResponseSchema,
  transactionsResponseSchema,
  walletResponseSchema,
} from "../../src/api/contract.js";
import { createPublicGuards, createPublicRouter } from "../../src/api/public.js";
import { setPublicQueries, type PublicQueries } from "../../src/public/queries.js";

/**
 * The public API, without a database.
 *
 * The routes are the real ones: validation, the two-second cache, the per-IP
 * limit and the error envelope. Only the queries are substituted, and the count
 * of calls proves the cache is doing something rather than merely being present.
 */

const MATCH_ID = "11111111-1111-4111-8111-111111111111";
const PLAYER_ID = "22222222-2222-4222-8222-222222222222";
const USER = { id: "33333333-3333-4333-8333-333333333333", displayName: "Ada" };

function fakeQueries(): PublicQueries & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const count = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };

  const match = {
    id: MATCH_ID,
    game: "carrom" as const,
    status: "finished" as const,
    tournamentId: null,
    isTournament: false,
    startedAt: "2026-10-30T10:00:00.000Z",
    endedAt: "2026-10-30T10:20:00.000Z",
    players: [
      {
        seat: 1 as const,
        playerId: PLAYER_ID,
        displayName: "Ada",
        isBot: false,
        botLevel: null,
        score: 25,
      },
    ],
    scores: { white: 25, black: 11 },
    roomId: null,
    seedCommit: "ab".repeat(32),
    seedReveal: "cd".repeat(32),
    resultSignature: "ef".repeat(32),
    logHeadHash: "12".repeat(32),
    result: { winner: "white" as const },
  };

  return {
    calls,
    config: () => ({
      currency: "NGN",
      moneyMode: "virtual" as const,
      minStakeMinor: 100,
      maxStakeMinor: 5_000_000,
      houseMarginBps: 600,
      limits: {
        minStakeMinor: 100,
        maxStakeMinor: 5_000_000,
        matchExposurePct: 20,
        largePayoutMinor: 5_000_000,
        betRateLimitPerMinute: 10,
        minAccountAgeHours: 24,
      },
      depositsEnabled: true,
    }),
    matches: () => {
      count("matches");
      return Promise.resolve({ matches: [match], nextCursor: null });
    },
    match: (id: string) => {
      count("match");
      return Promise.resolve(id === MATCH_ID ? match : null);
    },
    player: (id: string) => {
      count("player");
      return Promise.resolve(
        id === PLAYER_ID
          ? {
              id: PLAYER_ID,
              displayName: "Ada",
              isBot: false,
              botLevel: null,
              rating: 1200,
              played: 3,
              won: 2,
              lost: 1,
              recentResults: [],
            }
          : null,
      );
    },
    leaderboard: () => {
      count("leaderboard");
      return Promise.resolve([
        { rank: 1, playerId: PLAYER_ID, displayName: "Ada", isBot: false, rating: 1200, played: 3, won: 2 },
      ]);
    },
    tournaments: () => Promise.resolve([]),
    tournament: () => Promise.resolve(null),
    wallet: () => {
      count("wallet");
      return Promise.resolve({
        currency: "NGN",
        availableMinor: 25_000,
        atRiskMinor: 1_000,
        pendingWithdrawalMinor: 0,
        totalBalanceMinor: 26_000,
      });
    },
    transactions: () => {
      count("transactions");
      return Promise.resolve({
        currency: "NGN",
        transactions: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            kind: "bet_stake",
            refType: "bet",
            refId: null,
            amountMinor: -1_000,
            balanceAfterMinor: 25_000,
            createdAt: "2026-10-30T09:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    },
  };
}

let clock = 1_000_000;

function buildApp(queries: PublicQueries, ratePerMinute = 100): Express {
  const app = express();
  app.use(express.json());
  app.use(
    ...createPublicGuards({ ratePerMinute, cacheTtlMs: 2_000, now: () => clock }),
  );
  app.use(
    createPublicRouter({
      verifyUser: (token: string) => Promise.resolve(token === "good-token" ? USER : null),
    }),
  );
  app.use(
    (error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(500).json({ ok: false, error: String(error) });
    },
  );
  void queries;
  return app;
}

describe("the public API", () => {
  let queries: ReturnType<typeof fakeQueries>;

  beforeEach(() => {
    clock = 1_000_000;
    queries = fakeQueries();
    setPublicQueries(queries);
  });

  afterEach(() => {
    setPublicQueries(null);
  });

  it("serves the configuration in the shape the contract declares", async () => {
    const response = await request(buildApp(queries)).get("/api/config");

    expect(response.status).toBe(200);
    const parsed = configSchema.safeParse(response.body);
    expect(parsed.success).toBe(true);
    expect(response.body.currency).toBe("NGN");
    expect(response.body.moneyMode).toBe("virtual");
  });

  it("serves live matches, then serves the same response from the cache", async () => {
    const app = buildApp(queries);

    const first = await request(app).get("/api/matches/live");
    expect(first.status).toBe(200);
    expect(first.headers["x-cache"]).toBe("miss");
    expect(matchesResponseSchema.safeParse(first.body).success).toBe(true);

    const second = await request(app).get("/api/matches/live");
    expect(second.status).toBe(200);
    expect(second.headers["x-cache"]).toBe("hit");

    // The cache means the second read never reached the queries at all.
    expect(queries.calls.get("matches")).toBe(1);
  });

  it("lets the cache expire after two seconds", async () => {
    const app = buildApp(queries);

    await request(app).get("/api/matches/live");
    clock += 2_001;
    const after = await request(app).get("/api/matches/live");

    expect(after.headers["x-cache"]).toBe("miss");
    expect(queries.calls.get("matches")).toBe(2);
  });

  it("rejects a page size outside the allowed range", async () => {
    const app = buildApp(queries);

    for (const query of ["limit=0", "limit=101", "limit=abc", "cursor=" + "x".repeat(200)]) {
      const response = await request(app).get(`/api/matches/live?${query}`);
      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe("invalid_request");
    }
  });

  it("rejects an id that is not a uuid, and 404s one that does not exist", async () => {
    const app = buildApp(queries);

    const invalidId = await request(app).get("/api/matches/not-a-uuid");
    expect(invalidId.status).toBe(400);

    const missing = await request(app).get("/api/matches/44444444-4444-4444-8444-444444444444");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ ok: false, error: "not_found" });

    const found = await request(app).get(`/api/matches/${MATCH_ID}`);
    expect(found.status).toBe(200);
    expect(found.body.match.id).toBe(MATCH_ID);
  });

  it("serves a player and a leaderboard, rejecting an unknown bot filter", async () => {
    const app = buildApp(queries);

    const player = await request(app).get(`/api/players/${PLAYER_ID}`);
    expect(player.status).toBe(200);
    expect(player.body.player.displayName).toBe("Ada");

    const leaderboard = await request(app).get("/api/leaderboard?limit=5&bots=exclude");
    expect(leaderboard.status).toBe(200);
    expect(leaderboardResponseSchema.safeParse(leaderboard.body).success).toBe(true);

    const bad = await request(app).get("/api/leaderboard?bots=maybe");
    expect(bad.status).toBe(400);
  });

  it("rate limits per address and says when to come back", async () => {
    const app = buildApp(queries, 2);

    const first = await request(app).get("/api/config");
    const second = await request(app).get("/api/leaderboard");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const third = await request(app).get("/api/matches/upcoming");
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ ok: false, error: "rate_limited" });
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);

    // A new window opens a second later, so the same caller is served again.
    clock += 60_001;
    const after = await request(app).get("/api/config");
    expect(after.status).toBe(200);
  });

  it("refuses the signed-in routes without a token", async () => {
    const app = buildApp(queries);

    const wallet = await request(app).get("/api/me/wallet");
    expect(wallet.status).toBe(401);
    expect(wallet.body.error).toBe("missing_token");

    const transactions = await request(app).get("/api/me/transactions").set("authorization", "Bearer nope");
    expect(transactions.status).toBe(401);
    expect(transactions.body.error).toBe("invalid_token");
  });

  it("serves the signed-in player's wallet and transactions, never from the cache", async () => {
    const app = buildApp(queries);

    const wallet = await request(app).get("/api/me/wallet").set("authorization", "Bearer good-token");
    expect(wallet.status).toBe(200);
    expect(walletResponseSchema.safeParse(wallet.body).success).toBe(true);
    expect(wallet.headers["x-cache"]).toBeUndefined();

    await request(app).get("/api/me/wallet").set("authorization", "Bearer good-token");
    expect(queries.calls.get("wallet")).toBe(2);

    const transactions = await request(app)
      .get("/api/me/transactions?limit=2")
      .set("authorization", "Bearer good-token");
    expect(transactions.status).toBe(200);
    expect(transactionsResponseSchema.safeParse(transactions.body).success).toBe(true);
    expect(transactions.body.transactions[0].amountMinor).toBe(-1_000);
  });

  it("validates the page size on the signed-in routes too", async () => {
    const app = buildApp(queries);

    const response = await request(app)
      .get("/api/me/transactions?limit=1000")
      .set("authorization", "Bearer good-token");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });
});
