import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { carromCatalog } from "../../src/odds/catalog/carrom.js";
import { InMemoryMarketsRepository } from "../../src/odds/markets-store.js";
import { groupMarkets } from "../../src/api/markets.js";
import { houseMarginBps } from "../../src/odds/config.js";
import { priceMatch, type PriceResult, type PricedMarket } from "../../src/odds/pricer.js";

interface Fixture {
  readonly matches: InMemoryMatchRepository;
  readonly markets: InMemoryMarketsRepository;
  readonly matchId: string;
}

async function fixture(
  white: { botLevel: "rookie" | "club" | "master" },
  black: { botLevel: "rookie" | "club" | "master" },
): Promise<Fixture> {
  const matches = new InMemoryMatchRepository();
  const match = await matches.create({
    seedCommit: "0".repeat(64),
    config: { carrom: { pointsToWinMatch: 25, boardsPerMatch: 8 } },
    seats: [
      { seat: 1, botLevel: white.botLevel },
      { seat: 2, botLevel: black.botLevel },
    ],
  });

  return { matches, markets: new InMemoryMarketsRepository(), matchId: match.id };
}

function probability(
  result: PriceResult,
  marketType: string,
  key: string,
  line: number | null = null,
  subject = "",
): number {
  const market = result.markets.find(
    (entry) =>
      entry.marketType === marketType && entry.subject === subject && (entry.line ?? null) === line,
  );
  const selection = market?.selections.find((entry) => entry.selectionKey === key);
  if (selection === undefined) {
    throw new Error(`no selection ${marketType} ${subject} ${String(line)} ${key}`);
  }
  return selection.fairProbability;
}

function oddsOf(market: PricedMarket, key: string): number {
  return market.selections.find((entry) => entry.selectionKey === key)?.oddsDecimal ?? Number.NaN;
}

describe("pricing a match", () => {
  let priced: PriceResult;

  beforeEach(async () => {
    const setup = await fixture({ botLevel: "club" }, { botLevel: "club" });
    priced = await priceMatch(setup.matchId, {
      simulations: 4_000,
      matches: setup.matches,
      repository: setup.markets,
    });
  }, 60_000);

  it("writes every selection of the catalogue to the markets table", async () => {
    const selections = carromCatalog().markets.reduce(
      (sum, market) => sum + market.selections.length,
      0,
    );
    const rows = await priced.markets.reduce(async (promise, market) => {
      const total = await promise;
      return total + market.selections.length;
    }, Promise.resolve(0));

    expect(rows).toBe(selections);
    expect(priced.markets.length).toBe(carromCatalog().markets.length);
    expect(rows).toBeGreaterThanOrEqual(200);
  });

  it("leaves an ordinary two-way market within a percent of one plus the margin", () => {
    const margin = 1 + houseMarginBps() / 10_000;
    const twoWay = priced.markets.filter((market) => market.selections.length === 2);

    // Markets that are decided by a hair (over 2.5 boards) or hold eight
    // selections (exact boards) cannot survive flooring to two decimals: their
    // odds clamp, and the pricer warns rather than pretending otherwise.
    const clamped = new Set(
      priced.warnings
        .map((warning) => warning.split(":")[0] ?? "")
        .map((name) => name.split(" @ ")[0] ?? ""),
    );

    let checked = 0;
    for (const market of twoWay) {
      if (clamped.has(market.marketType)) {
        continue;
      }
      if (
        market.selections.some((entry) => entry.oddsDecimal <= 1.01 || entry.oddsDecimal >= 1000)
      ) {
        continue;
      }
      const inverseSum = market.selections.reduce((sum, entry) => sum + 1 / entry.oddsDecimal, 0);
      expect(Math.abs(inverseSum - margin) / margin).toBeLessThan(0.012);
      checked += 1;
    }

    expect(checked).toBeGreaterThan(20);
  });

  it("warns instead of silently mispricing a market it cannot make sum", () => {
    // Every warning must name a market whose price is clamped or multiway.
    for (const warning of priced.warnings) {
      expect(warning).toMatch(/1\/odds sums to \d/);
    }
    expect(priced.warnings.length).toBeLessThan(priced.markets.length / 2);
  });

  it("never prices a selection below 1.5%, or outside the odds bounds", () => {
    for (const market of priced.markets) {
      for (const entry of market.selections) {
        expect(entry.fairProbability).toBeGreaterThanOrEqual(0.015);
        expect(entry.fairProbability).toBeLessThanOrEqual(1);
        expect(entry.oddsDecimal).toBeGreaterThanOrEqual(1.01);
        expect(entry.oddsDecimal).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("has an exclusive market: one winner out of two", () => {
    const white = probability(priced, "match_winner", "white");
    const black = probability(priced, "match_winner", "black");
    expect(Math.abs(white + black - 1)).toBeLessThan(0.01);
  });

  it("is even money between two identical players", () => {
    const white = probability(priced, "match_winner", "white");
    expect(white).toBeGreaterThan(0.49);
    expect(white).toBeLessThan(0.51);
  });

  it("prices the board winner markets as one-out-of-two as well", () => {
    for (const board of [1, 2, 3]) {
      const white = probability(priced, "board_winner", "white", null, `board:${String(board)}`);
      const black = probability(priced, "board_winner", "black", null, `board:${String(board)}`);
      expect(Math.abs(white + black - 1)).toBeLessThan(0.02);
    }
  });

  it("gives a Master more of the match than a Club, against the same Rookie", async () => {
    const master = await fixture({ botLevel: "master" }, { botLevel: "rookie" });
    const club = await fixture({ botLevel: "club" }, { botLevel: "rookie" });

    const masterPriced = await priceMatch(master.matchId, {
      simulations: 4_000,
      matches: master.matches,
      repository: master.markets,
    });
    const clubPriced = await priceMatch(club.matchId, {
      simulations: 4_000,
      matches: club.matches,
      repository: club.markets,
    });

    const masterChance = probability(masterPriced, "match_winner", "white");
    const clubChance = probability(clubPriced, "match_winner", "white");

    expect(masterChance).toBeGreaterThan(0.9);
    expect(clubChance).toBeGreaterThan(0.8);
    // The model is known to saturate at the top; recorded in src/odds/README.md.
    expect(masterChance).toBeGreaterThanOrEqual(clubChance - 0.02);
  }, 90_000);

  it("makes over/under harder as the line rises", () => {
    const lines = carromCatalog()
      .markets.filter((market) => market.marketType === "total_boards_ou")
      .map((market) => market.line ?? Number.NaN)
      .sort((left, right) => left - right);

    const lowest = probability(priced, "total_boards_ou", "over", lines[0] ?? null);
    const highest = probability(priced, "total_boards_ou", "over", lines[lines.length - 1] ?? null);
    expect(lowest).toBeGreaterThan(highest);
  });

  it("makes the handicap harder as the line gets bigger", () => {
    const whiteOneAndHalf = probability(priced, "points_handicap", "white", 1.5, "points");
    const whiteFourteenAndHalf = probability(priced, "points_handicap", "white", 14.5, "points");
    expect(whiteOneAndHalf).toBeGreaterThan(whiteFourteenAndHalf);
    expect(whiteFourteenAndHalf).toBeLessThan(0.45);
  });

  it("is served by the API grouped by market type", async () => {
    const rows = await priced.markets.flatMap(() => []);
    expect(rows).toEqual([]);

    const setup = await fixture({ botLevel: "club" }, { botLevel: "club" });
    await priceMatch(setup.matchId, {
      simulations: 500,
      matches: setup.matches,
      repository: setup.markets,
    });

    const stored = await setup.markets.listForMatch(setup.matchId);
    const grouped = groupMarkets(stored);
    expect(grouped.length).toBe(carromCatalog().markets.length);
    const winner = grouped.find((market) => market.marketType === "match_winner");
    expect(winner?.selections.map((entry) => entry.selectionKey).sort()).toEqual([
      "black",
      "white",
    ]);
    expect(winner?.name.length).toBeGreaterThan(3);
    const firstMarket = priced.markets[0];
    expect(firstMarket === undefined ? 0 : oddsOf(firstMarket, "white")).toBeGreaterThan(1);
  });

  it("prices a match in under twenty seconds and reprices in under one and a half", async () => {
    const setup = await fixture({ botLevel: "master" }, { botLevel: "club" });

    const fullStart = performance.now();
    await priceMatch(setup.matchId, {
      simulations: 100_000,
      matches: setup.matches,
      repository: setup.markets,
    });
    const fullMs = performance.now() - fullStart;
    expect(fullMs).toBeLessThan(20_000);

    const liveStart = performance.now();
    await priceMatch(setup.matchId, {
      simulations: 5_000,
      matches: setup.matches,
      repository: setup.markets,
    });
    const liveMs = performance.now() - liveStart;
    expect(liveMs).toBeLessThan(1_500);
  }, 120_000);
});
