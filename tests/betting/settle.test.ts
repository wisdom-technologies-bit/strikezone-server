import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryBetsRepository, type BetsRepository } from "../../src/betting/bets-store.js";
import { settleMatch } from "../../src/betting/settle.js";
import type { BetRow } from "../../src/betting/types.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { InMemoryMarketsRepository, type MarketRow } from "../../src/odds/markets-store.js";
import type { MatchStats } from "../../src/odds/stats.js";
import { InMemoryLedger } from "../../src/wallet/ledger.js";
import { finishedMatch, shortMatch } from "../odds/fixtures.js";
import { seededUniform, simulateLudoGame } from "../../src/odds/ludo-sim.js";

/**
 * Settlement: one verified match, its bets and the money.
 *
 * The verifier and the stats are injected here. Everything else is the real
 * code: the real catalogue decides each market, the real rules plan the money,
 * and the real ledger moves it.
 */

const MATCH_ID = "c0000000-0000-4000-8000-00000000m001";

function market(
  overrides: Partial<MarketRow> & Pick<MarketRow, "marketType" | "selectionKey">,
): MarketRow {
  return {
    matchId: MATCH_ID,
    subject: "",
    line: null,
    fairProbability: 0.5,
    oddsDecimal: 2,
    maxStakeMinor: 100_000,
    isLive: false,
    status: "open",
    ...overrides,
  };
}

function bet(overrides: Partial<BetRow> & Pick<BetRow, "id" | "marketId" | "stakeMinor">): BetRow {
  return {
    userId: "user-1",
    oddsLocked: 2,
    potentialPayoutMinor: overrides.stakeMinor * 2,
    status: "open",
    result: null,
    payoutMinor: null,
    idempotencyKey: `key-${overrides.id}`,
    placedAt: new Date().toISOString(),
    settledAt: null,
    reviewReason: null,
    ...overrides,
  };
}

interface Book {
  readonly bets: InMemoryBetsRepository;
  readonly markets: InMemoryMarketsRepository;
  readonly ledger: InMemoryLedger;
  readonly matches: InMemoryMatchRepository;
}

async function book(): Promise<Book> {
  const ledgerBook = new InMemoryLedger("NGN");
  const markets = new InMemoryMarketsRepository();

  // Fund the house, then the player: the money paths assume a funded book.
  await ledgerBook.post({
    idempotencyKey: "topup",
    kind: "bankroll_topup",
    refType: "bankroll",
    refId: null,
    entries: [
      { accountId: await ledgerBook.treasuryAccount(), amountMinor: -50_000_000 },
      { accountId: await ledgerBook.houseAccount(), amountMinor: 50_000_000 },
    ],
  });
  await ledgerBook.post({
    idempotencyKey: "fund-user",
    kind: "deposit",
    refType: "deposit",
    refId: null,
    entries: [
      { accountId: await ledgerBook.treasuryAccount(), amountMinor: -5_000_000 },
      { accountId: await ledgerBook.userAccount("user-1"), amountMinor: 5_000_000 },
    ],
  });

  return {
    bets: new InMemoryBetsRepository(),
    markets,
    ledger: ledgerBook,
    matches: new InMemoryMatchRepository(),
  };
}

function deps(underTest: Book, stats: MatchStats = finishedMatch(), verified = true) {
  return {
    matches: underTest.matches,
    markets: underTest.markets,
    bets: underTest.bets as BetsRepository,
    ledger: underTest.ledger,
    largePayoutMinor: 5_000_000,
    verify: (matchId: string) =>
      Promise.resolve({
        ok: verified,
        matchId,
        checks: [],
        failure: verified ? null : "signature",
        shots: verified ? 24 : 0,
      }),
    stats: () => Promise.resolve(stats),
  };
}

describe("settlement", () => {
  beforeEach(() => {
    // The match repository must know the match exists for the facts settlement reads.
  });

  it("pays a winning bet, takes the stake from escrow and the profit from the house", async () => {
    const underTest = await book();
    const match = await underTest.matches.create({
      seedCommit: "commit",
      seats: [
        { seat: 1, botLevel: "club" },
        { seat: 2, botLevel: "rookie" },
      ],
    });
    const winnerSeat = match.seats[0];

    if (winnerSeat === undefined) {
      throw new Error("the fixture match has no seats");
    }

    const stats = finishedMatch();
    const winner = stats.winner === "black" ? "black" : "white";

    underTest.markets.upsert([
      market({ matchId: match.id, marketType: "match_winner", selectionKey: winner }),
    ]);
    underTest.bets.addMarket({
      id: "win-market",
      match_id: match.id,
      market_type: "match_winner",
      subject: "",
      line: null,
      selection_key: winner,
    });
    underTest.bets.addBet(
      bet({ id: "bet-catalogue", marketId: "win-market", stakeMinor: 10_000 }),
      "win-market",
    );
    await underTest.ledger.post({
      idempotencyKey: "bet_stake:bet-catalogue",
      kind: "bet_stake",
      refType: "bet",
      refId: "bet-catalogue",
      entries: [
        { accountId: await underTest.ledger.userAccount("user-1"), amountMinor: -10_000 },
        { accountId: await underTest.ledger.escrowAccount(), amountMinor: 10_000 },
      ],
    });

    const report = await settleMatch(match.id, deps(underTest, stats));

    expect(report.verified).toBe(true);
    expect(report.flagged).toBe(false);
    expect(report.won + report.lost + report.voided).toBeGreaterThan(0);

    const settled = await underTest.bets.get("bet-catalogue");
    expect(settled?.status).toBe("won");
    expect(settled?.payoutMinor).toBe(20_000);

    const balance = await underTest.ledger.balanceOf(await underTest.ledger.userAccount("user-1"));
    // Started with 5,000,000, staked 10,000, and won the 20,000 payout back.
    expect(balance).toBe(5_000_000 - 10_000 + 20_000);

    // The stake left escrow, so none is left at risk.
    expect(await underTest.ledger.balanceOf(await underTest.ledger.escrowAccount())).toBe(0);

    void winnerSeat;
  });

  it("settles a losing bet: the stake goes to the house and the player gets nothing", async () => {
    const underTest = await book();
    const match = await underTest.matches.create({
      seedCommit: "commit",
      seats: [
        { seat: 1, botLevel: "club" },
        { seat: 2, botLevel: "rookie" },
      ],
    });

    const stats = finishedMatch();
    const loser = stats.winner === "black" ? "white" : "black";

    underTest.markets.upsert([
      market({ matchId: match.id, marketType: "match_winner", selectionKey: loser }),
    ]);
    underTest.bets.addMarket({
      id: "loser-market",
      match_id: match.id,
      market_type: "match_winner",
      subject: "",
      line: null,
      selection_key: loser,
    });
    underTest.bets.addBet(
      bet({ id: "bet-loss", marketId: "loser-market", stakeMinor: 5_000 }),
      "loser-market",
    );
    await underTest.ledger.post({
      idempotencyKey: "bet_stake:bet-loss",
      kind: "bet_stake",
      refType: "bet",
      refId: "bet-loss",
      entries: [
        { accountId: await underTest.ledger.userAccount("user-1"), amountMinor: -5_000 },
        { accountId: await underTest.ledger.escrowAccount(), amountMinor: 5_000 },
      ],
    });

    const houseBefore = await underTest.ledger.balanceOf(await underTest.ledger.houseAccount());
    const report = await settleMatch(match.id, deps(underTest, stats));

    expect(report.lost).toBe(1);
    expect((await underTest.bets.get("bet-loss"))?.status).toBe("lost");
    expect((await underTest.bets.get("bet-loss"))?.payoutMinor).toBe(0);

    const houseAfter = await underTest.ledger.balanceOf(await underTest.ledger.houseAccount());
    expect(houseAfter - houseBefore).toBe(5_000);
  });

  it("voids every bet when the match was abandoned before its first shot", async () => {
    const underTest = await book();
    const match = await underTest.matches.create({
      seedCommit: "commit",
      seats: [
        { seat: 1, botLevel: "club" },
        { seat: 2, botLevel: "rookie" },
      ],
    });

    underTest.markets.upsert([
      market({ matchId: match.id, marketType: "match_winner", selectionKey: "white" }),
    ]);
    underTest.bets.addMarket({
      id: "abandoned-market",
      match_id: match.id,
      market_type: "match_winner",
      subject: "",
      line: null,
      selection_key: "white",
    });
    underTest.bets.addBet(
      bet({ id: "bet-void", marketId: "abandoned-market", stakeMinor: 7_000 }),
      "abandoned-market",
    );
    await underTest.ledger.post({
      idempotencyKey: "bet_stake:bet-void",
      kind: "bet_stake",
      refType: "bet",
      refId: "bet-void",
      entries: [
        { accountId: await underTest.ledger.userAccount("user-1"), amountMinor: -7_000 },
        { accountId: await underTest.ledger.escrowAccount(), amountMinor: 7_000 },
      ],
    });

    const balanceBefore = await underTest.ledger.balanceOf(
      await underTest.ledger.userAccount("user-1"),
    );
    const report = await settleMatch(match.id, {
      ...deps(underTest, shortMatch()),
      verify: (matchId: string) =>
        Promise.resolve({ ok: true, matchId, checks: [], failure: null, shots: 0 }),
    });

    expect(report.voidReason).toBe("abandoned_before_first_shot");
    expect(report.voided).toBe(1);
    expect((await underTest.bets.get("bet-void"))?.status).toBe("void");
    expect(await underTest.ledger.balanceOf(await underTest.ledger.userAccount("user-1"))).toBe(
      balanceBefore + 7_000,
    );
  });

  it("holds a payout above the threshold instead of paying it", async () => {
    const underTest = await book();
    const match = await underTest.matches.create({
      seedCommit: "commit",
      seats: [
        { seat: 1, botLevel: "club" },
        { seat: 2, botLevel: "rookie" },
      ],
    });

    const stats = finishedMatch();
    const winner = stats.winner === "black" ? "black" : "white";

    underTest.markets.upsert([
      market({
        matchId: match.id,
        marketType: "match_winner",
        selectionKey: winner,
        oddsDecimal: 10,
      }),
    ]);
    underTest.bets.addMarket({
      id: "held-market",
      match_id: match.id,
      market_type: "match_winner",
      subject: "",
      line: null,
      selection_key: winner,
    });
    underTest.bets.addBet(
      bet({
        id: "bet-held",
        marketId: "held-market",
        stakeMinor: 1_000_000,
        oddsLocked: 10,
        potentialPayoutMinor: 10_000_000,
      }),
      "held-market",
    );
    await underTest.ledger.post({
      idempotencyKey: "bet_stake:bet-held",
      kind: "bet_stake",
      refType: "bet",
      refId: "bet-held",
      entries: [
        { accountId: await underTest.ledger.userAccount("user-1"), amountMinor: -1_000_000 },
        { accountId: await underTest.ledger.escrowAccount(), amountMinor: 1_000_000 },
      ],
    });

    const balanceBefore = await underTest.ledger.balanceOf(
      await underTest.ledger.userAccount("user-1"),
    );
    const report = await settleMatch(match.id, deps(underTest, stats));

    expect(report.held).toBe(1);
    expect(report.paidMinor).toBe(0);
    expect((await underTest.bets.get("bet-held"))?.status).toBe("pending_review");
    expect(await underTest.ledger.balanceOf(await underTest.ledger.userAccount("user-1"))).toBe(
      balanceBefore,
    );
  });

  it("refuses to settle an unverified match and flags it", async () => {
    const underTest = await book();
    const match = await underTest.matches.create({
      seedCommit: "commit",
      seats: [
        { seat: 1, botLevel: "club" },
        { seat: 2, botLevel: "rookie" },
      ],
    });

    const report = await settleMatch(match.id, deps(underTest, finishedMatch(), false));

    expect(report.verified).toBe(false);
    expect(report.flagged).toBe(true);
    expect(report.settled).toBe(0);
    expect(underTest.bets.flaggedReason(match.id)).toBe("signature");
  });

  it("settles a match twice without paying twice", async () => {
    const underTest = await book();
    const match = await underTest.matches.create({
      seedCommit: "commit",
      seats: [
        { seat: 1, botLevel: "club" },
        { seat: 2, botLevel: "rookie" },
      ],
    });

    const stats = finishedMatch();
    const winner = stats.winner === "black" ? "black" : "white";

    underTest.markets.upsert([
      market({ matchId: match.id, marketType: "match_winner", selectionKey: winner }),
    ]);
    underTest.bets.addMarket({
      id: "twice-market",
      match_id: match.id,
      market_type: "match_winner",
      subject: "",
      line: null,
      selection_key: winner,
    });
    underTest.bets.addBet(
      bet({ id: "bet-twice", marketId: "twice-market", stakeMinor: 2_000 }),
      "twice-market",
    );
    await underTest.ledger.post({
      idempotencyKey: "bet_stake:bet-twice",
      kind: "bet_stake",
      refType: "bet",
      refId: "bet-twice",
      entries: [
        { accountId: await underTest.ledger.userAccount("user-1"), amountMinor: -2_000 },
        { accountId: await underTest.ledger.escrowAccount(), amountMinor: 2_000 },
      ],
    });

    const first = await settleMatch(match.id, deps(underTest, stats));
    const balanceAfterFirst = await underTest.ledger.balanceOf(
      await underTest.ledger.userAccount("user-1"),
    );

    const second = await settleMatch(match.id, deps(underTest, stats));

    expect(first.settled).toBe(1);
    expect(second.settled).toBe(0);
    expect(await underTest.ledger.balanceOf(await underTest.ledger.userAccount("user-1"))).toBe(
      balanceAfterFirst,
    );
  });
});

/**
 * A Ludo bet settles against the Ludo catalogue.
 *
 * This is the wiring test: before it, settlement read every match as Carrom, so a
 * Ludo market had no answer and every bet on one came back void. The seams below
 * are the verifier and the facts, exactly as the Carrom tests inject them; the
 * catalogue and the money are the real ones.
 */
describe("ludo settlement", () => {
  /** A finished four bot game that seat 0 (red) won. */
  function redWins() {
    const policies = { 0: "cautious", 1: "cautious", 2: "cautious", 3: "cautious" } as const;
    for (let index = 0; index < 40; index += 1) {
      const stats = simulateLudoGame({
        policies,
        random: seededUniform(`ludo-settle:${String(index)}`),
      });
      if (stats.winnerSeat === 0) {
        return stats;
      }
    }
    throw new Error("no four bot game gave red a win");
  }

  it("pays a winner-market bet on the seat that won", { timeout: 60_000 }, async () => {
    const underTest = await book();
    const match = await underTest.matches.create({
      game: "ludo",
      seedCommit: "commit",
      seats: [
        { seat: 1, botLevel: "club", botPolicy: "cautious" },
        { seat: 2, botLevel: "club", botPolicy: "cautious" },
        { seat: 3, botLevel: "club", botPolicy: "cautious" },
        { seat: 4, botLevel: "club", botPolicy: "cautious" },
      ],
    });

    const stats = redWins();
    underTest.markets.upsert([
      market({ matchId: match.id, marketType: "ludo_match_winner", selectionKey: "red" }),
    ]);
    underTest.bets.addMarket({
      id: "red-market",
      match_id: match.id,
      market_type: "ludo_match_winner",
      subject: "",
      line: null,
      selection_key: "red",
    });
    underTest.bets.addBet(
      bet({ id: "bet-red", marketId: "red-market", stakeMinor: 10_000 }),
      "red-market",
    );

    // Placing the bet moved the stake into escrow; settlement only has to release
    // it, which is the same shape the Carrom tests use.
    await underTest.ledger.post({
      idempotencyKey: "place-bet-red",
      kind: "bet_stake",
      refType: "bet",
      refId: "bet-red",
      entries: [
        {
          accountId: await underTest.ledger.userAccount("user-1"),
          amountMinor: -10_000,
        },
        { accountId: await underTest.ledger.escrowAccount(), amountMinor: 10_000 },
      ],
    });

    const report = await settleMatch(match.id, {
      matches: underTest.matches,
      markets: underTest.markets,
      bets: underTest.bets as BetsRepository,
      ledger: underTest.ledger,
      largePayoutMinor: 5_000_000,
      verify: (matchId: string) =>
        Promise.resolve({ ok: true, matchId, checks: [], failure: null, shots: 200 }),
      ludoStats: () => Promise.resolve(stats),
    });

    expect(report.verified).toBe(true);
    expect(report.voidReason).toBeNull();
    expect(report.settled).toBe(1);
    expect(report.won).toBe(1);
    expect(report.paidMinor).toBe(20_000);

    const settled = await underTest.bets.get("bet-red");
    expect(settled?.status).toBe("won");
    expect(await underTest.ledger.balanceOf(await underTest.ledger.userAccount("user-1"))).toBe(
      5_000_000 - 10_000 + 20_000,
    );
  });
});
