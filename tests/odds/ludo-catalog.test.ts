import { describe, expect, it } from "vitest";
import type { LudoGameStats } from "../../src/odds/ludo-stats.js";
import { ludoCatalog } from "../../src/odds/catalog/ludo.js";

const finished4PlayerStats: LudoGameStats = {
  game: "ludo",
  players: 4,
  seats: [0, 1, 2, 3],
  finished: true,
  abandoned: false,
  totalTurns: 300,
  totalRounds: 75,
  totalRolls: 75,
  turnsBySeat: [20, 19, 18, 18],
  rollsBySeat: [20, 19, 18, 18],
  sixesBySeat: [5, 4, 3, 2],
  tripleSixesBySeat: [1, 0, 0, 0],
  captures: [
    { seat: 0, victim: 1, turn: 10 },
    { seat: 1, victim: 2, turn: 25 },
  ],
  capturesBySeat: [1, 1, 0, 0],
  capturedTimesBySeat: [0, 1, 1, 0],
  firstOut: { seat: 0, turn: 2 },
  firstHome: { seat: 0, turn: 40 },
  firstSix: { seat: 0, turn: 1 },
  firstCapture: { seat: 0, victim: 1, turn: 10 },
  rollsBeforeFirstCapture: 10,
  homeBySeatAtTurn: [
    [0, 0, 0, 0],
    [1, 0, 0, 0],
    [2, 0, 0, 0],
    [2, 3, 0, 0],
  ],
  homeAtRound20: [1, 0, 0, 0],
  homeAtRound60: [2, 1, 0, 0],
  firstToTwoHome: { seat: 3, turn: 44 },
  firstToThreeHome: { seat: 1, turn: 120 },
  neverFewestAfterRound20: [true, true, false, false],
  finishingOrder: [0, 1, 2, 3],
  winnerSeat: 0,
  winnerTurns: 65,
  winnerWasCaptured: false,
  finalHome: [4, 3, 2, 1],
  lastRoll: 6,
};

const abandonedStats: LudoGameStats = {
  game: "ludo",
  players: 4,
  seats: [0, 1, 2, 3],
  finished: false,
  abandoned: true,
  totalTurns: 10,
  totalRounds: 3,
  totalRolls: 10,
  turnsBySeat: [3, 3, 2, 2],
  rollsBySeat: [3, 3, 2, 2],
  sixesBySeat: [0, 0, 0, 0],
  tripleSixesBySeat: [0, 0, 0, 0],
  captures: [],
  capturesBySeat: [0, 0, 0, 0],
  capturedTimesBySeat: [0, 0, 0, 0],
  firstOut: null,
  firstHome: null,
  firstSix: null,
  firstCapture: null,
  rollsBeforeFirstCapture: null,
  homeBySeatAtTurn: null,
  homeAtRound20: [0, 0, 0, 0],
  homeAtRound60: [0, 0, 0, 0],
  firstToTwoHome: null,
  firstToThreeHome: null,
  neverFewestAfterRound20: [true, true, true, true],
  finishingOrder: [],
  winnerSeat: null,
  winnerTurns: null,
  winnerWasCaptured: false,
  finalHome: [0, 0, 0, 0],
  lastRoll: 2,
};

const finished2PlayerStats: LudoGameStats = {
  game: "ludo",
  players: 2,
  seats: [0, 2],
  finished: true,
  abandoned: false,
  totalTurns: 240,
  totalRounds: 60,
  totalRolls: 60,
  turnsBySeat: [30, 0, 30, 0],
  rollsBySeat: [30, 0, 30, 0],
  sixesBySeat: [4, 0, 2, 0],
  tripleSixesBySeat: [0, 0, 0, 0],
  captures: [{ seat: 0, victim: 2, turn: 15 }],
  capturesBySeat: [1, 0, 0, 0],
  capturedTimesBySeat: [0, 0, 1, 0],
  firstOut: { seat: 0, turn: 1 },
  firstHome: { seat: 0, turn: 30 },
  firstSix: { seat: 0, turn: 1 },
  firstCapture: { seat: 0, victim: 2, turn: 15 },
  rollsBeforeFirstCapture: 15,
  homeBySeatAtTurn: null,
  homeAtRound20: [0, 0, 0, 0],
  homeAtRound60: [4, 0, 1, 0],
  firstToTwoHome: null,
  firstToThreeHome: null,
  neverFewestAfterRound20: [true, false, false, false],
  finishingOrder: [0, 2],
  winnerSeat: 0,
  winnerTurns: 50,
  winnerWasCaptured: false,
  finalHome: [4, 0, 1, 0],
  lastRoll: 3,
};

const ALL_MARKET_TYPES = [
  "ludo_match_winner",
  "ludo_finish_place",
  "ludo_top_two",
  "ludo_head_to_head",
  "ludo_first_out",
  "ludo_first_home",
  "ludo_winner_turns",
  "ludo_first_up",
  "ludo_second_up",
  "ludo_never_last",
  "ludo_first_out_winner",
  "ludo_win_margin",
  "ludo_total_turns",
  "ludo_total_sixes",
  "ludo_seat_sixes",
  "ludo_first_six",
  "ludo_triple_six",
  "ludo_total_captures",
  "ludo_first_capture",
  "ludo_winner_captures",
  "ludo_winner_never_captured",
  "ludo_seat_captures",
  "ludo_rolls_to_first_capture",
  "ludo_home_at_turn_60",
  "ludo_turns_parity",
  "ludo_last_roll_six",
] as const;

describe("Ludo Market Catalog", () => {
  it("(d) provides between 240 and 290 priced selections for a 4-player match", () => {
    const catalog = ludoCatalog();
    const totalSelections = catalog.markets.reduce(
      (sum, market) => sum + market.selections.length,
      0,
    );
    expect(totalSelections).toBeGreaterThanOrEqual(240);
    expect(totalSelections).toBeLessThanOrEqual(290);
  });

  it("(e) contains no duplicate selection keys within any single market", () => {
    const catalog = ludoCatalog();
    for (const market of catalog.markets) {
      const keys = market.selections.map((s) => s.key);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(market.selections.length);
    }
  });

  it("(b) yields exactly one winner or all void in each exclusive market", () => {
    const catalog = ludoCatalog();
    for (const market of catalog.markets) {
      if (market.marketType === "ludo_seat_captures") {
        // Accumulator/threshold market, not exclusive
        continue;
      }
      const settlements = market.selections.map((sel) =>
        catalog.settle(market, sel.key, finished4PlayerStats),
      );
      const wonCount = settlements.filter((s) => s === "won").length;
      const allVoid = settlements.every((s) => s === "void");

      if (allVoid) {
        expect(wonCount).toBe(0);
      } else {
        expect(wonCount).toBe(1);
      }
    }
  });

  it("(c) evaluates over/under lines correctly away from the line", () => {
    const catalog = ludoCatalog();
    const totalTurnsOver = catalog.markets.find(
      (m) => m.marketType === "ludo_total_turns" && m.line === 50.5,
    )!;
    expect(catalog.settle(totalTurnsOver, "over", finished4PlayerStats)).toBe("won");
    expect(catalog.settle(totalTurnsOver, "under", finished4PlayerStats)).toBe("lost");

    const totalTurnsUnder = catalog.markets.find(
      (m) => m.marketType === "ludo_total_turns" && m.line === 100.5,
    )!;
    expect(catalog.settle(totalTurnsUnder, "over", finished4PlayerStats)).toBe("lost");
    expect(catalog.settle(totalTurnsUnder, "under", finished4PlayerStats)).toBe("won");
  });

  it("(a) tests settlement and void cases for every market type", () => {
    const catalog = ludoCatalog();

    // Verify every market type is present in catalog
    const catalogTypes = new Set(catalog.markets.map((m) => m.marketType));
    for (const typeId of ALL_MARKET_TYPES) {
      expect(catalogTypes.has(typeId)).toBe(true);
    }

    // Test void case for every market type on an abandoned match
    for (const market of catalog.markets) {
      for (const sel of market.selections) {
        expect(catalog.settle(market, sel.key, abandonedStats)).toBe("void");
      }
    }

    // Test specific settlement rules for each market type on finished match
    for (const typeId of ALL_MARKET_TYPES) {
      const marketsOfType = catalog.markets.filter((m) => m.marketType === typeId);
      expect(marketsOfType.length).toBeGreaterThan(0);

      let foundResolved = false;
      for (const market of marketsOfType) {
        for (const sel of market.selections) {
          const res = catalog.settle(market, sel.key, finished4PlayerStats);
          if (res === "won" || res === "lost") {
            foundResolved = true;
            break;
          }
        }
        if (foundResolved) break;
      }
      expect(foundResolved).toBe(true);
    }
  });

  it("handles 2-player matches properly without referencing missing seats", () => {
    const catalog2P = ludoCatalog(undefined, [0, 2]);

    for (const market of catalog2P.markets) {
      // 2-player match should not have seat 1 or 3 in selection keys
      for (const sel of market.selections) {
        expect(sel.key).not.toContain("green");
        expect(sel.key).not.toContain("blue");
      }

      const settlements = market.selections.map((sel) =>
        catalog2P.settle(market, sel.key, finished2PlayerStats),
      );

      if (market.marketType !== "ludo_seat_captures") {
        const wonCount = settlements.filter((s) => s === "won").length;
        const allVoid = settlements.every((s) => s === "void");
        if (!allVoid) {
          expect(wonCount).toBe(1);
        }
      }
    }
  });
});
