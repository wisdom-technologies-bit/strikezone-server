import { describe, expect, it } from "vitest";
import { carromCatalog, type CatalogMarket } from "../../src/odds/catalog/carrom.js";
import type { MatchStats } from "../../src/odds/stats.js";
import { drawnMatch, finishedMatch, shortMatch, unfinishedMatch } from "./fixtures.js";

const catalog = carromCatalog();

type Settlement = ReturnType<typeof catalog.settle>;

/** Settles a selection against a fixture without needing a catalogue instance. */
function settle(
  marketType: string,
  key: string,
  stats: MatchStats = finishedMatch(),
  line: number | null = null,
  subject = "",
): Settlement {
  return catalog.settle({ marketType, subject, line }, key, stats);
}

const MARKET_TYPES = new Set(catalog.markets.map((market: CatalogMarket) => market.marketType));

describe("the catalogue", () => {
  it("offers every market type the spec names", () => {
    const expected = [
      "match_winner",
      "board_winner",
      "points_handicap",
      "boards_handicap",
      "winning_margin",
      "loser_score",
      "total_boards_ou",
      "exact_boards",
      "lead_1up",
      "lead_2up",
      "lead_never_down",
      "both_win_board",
      "comeback_board_1",
      "board1_match_winner",
      "total_points",
      "player_points",
      "board1_points",
      "queen_board1",
      "queen_covered",
      "queen_wins_board",
      "queen_first4",
      "first_coin",
      "board1_coins",
      "total_fouls",
      "first_foul",
      "foul_board1",
      "striker_pocket",
      "whitewash",
      "match_minutes",
      "board1_shots",
    ];

    for (const type of expected) {
      expect(MARKET_TYPES.has(type), `missing ${type}`).toBe(true);
    }
  });

  it("prices about two hundred and fifty selections on one match", () => {
    const selections = catalog.markets.reduce((sum, market) => sum + market.selections.length, 0);
    expect(selections).toBeGreaterThanOrEqual(200);
    expect(selections).toBeLessThanOrEqual(300);
  });

  it("has six board winner markets and the default lines", () => {
    expect(catalog.markets.filter((market) => market.marketType === "board_winner")).toHaveLength(
      6,
    );

    const lines = (type: string): number[] =>
      catalog.markets
        .filter((market) => market.marketType === type)
        .map((market) => market.line ?? Number.NaN);

    expect(Math.min(...lines("points_handicap"))).toBe(1.5);
    expect(Math.max(...lines("points_handicap"))).toBe(14.5);
    expect(lines("boards_handicap")).toEqual([0.5, 1.5, 2.5]);
    expect(Math.min(...lines("total_boards_ou"))).toBe(2.5);
    expect(Math.max(...lines("total_boards_ou"))).toBe(7.5);
    expect(Math.min(...lines("total_fouls"))).toBe(0.5);
    expect(Math.max(...lines("total_fouls"))).toBe(5.5);
  });

  it("voids everything on a match that has not finished", () => {
    const live = unfinishedMatch();
    for (const market of catalog.markets) {
      for (const selection of market.selections) {
        expect(catalog.settle(market, selection.key, live)).toBe("void");
      }
    }
  });
});

describe("settling a finished match: white 25, black 18, eight boards", () => {
  it("settles the match winner", () => {
    expect(settle("match_winner", "white")).toBe("won");
    expect(settle("match_winner", "black")).toBe("lost");
    expect(settle("match_winner", "white", drawnMatch())).toBe("void");
  });

  it("settles each board winner, and voids a board that was never played", () => {
    expect(settle("board_winner", "white", finishedMatch(), null, "board:1")).toBe("won");
    expect(settle("board_winner", "black", finishedMatch(), null, "board:1")).toBe("lost");
    expect(settle("board_winner", "black", finishedMatch(), null, "board:6")).toBe("won");
    expect(settle("board_winner", "white", shortMatch(), null, "board:2")).toBe("void");
  });

  it("settles the points handicap: white gives the line", () => {
    expect(settle("points_handicap", "white", finishedMatch(), 1.5)).toBe("won");
    expect(settle("points_handicap", "black", finishedMatch(), 1.5)).toBe("lost");
    expect(settle("points_handicap", "white", finishedMatch(), 8.5)).toBe("lost");
    expect(settle("points_handicap", "black", finishedMatch(), 8.5)).toBe("won");
    expect(settle("points_handicap", "white", finishedMatch(), 7)).toBe("push");
    expect(settle("points_handicap", "white", finishedMatch(), 7)).not.toBe("lost");
  });

  it("settles the boards handicap", () => {
    expect(settle("boards_handicap", "white", finishedMatch(), 0.5)).toBe("won");
    expect(settle("boards_handicap", "black", finishedMatch(), 4.5)).toBe("won");
    expect(settle("boards_handicap", "white", finishedMatch(), 4)).toBe("push");
  });

  it("settles the winning margin bands", () => {
    expect(settle("winning_margin", "6-10")).toBe("won");
    expect(settle("winning_margin", "1-5")).toBe("lost");
    expect(settle("winning_margin", "6-10", drawnMatch())).toBe("void");
  });

  it("settles the loser's final score bands", () => {
    expect(settle("loser_score", "15-19")).toBe("won");
    expect(settle("loser_score", "20-24")).toBe("lost");
  });

  it("settles total boards over and under, and pushes on the line", () => {
    expect(settle("total_boards_ou", "over", finishedMatch(), 7.5)).toBe("won");
    expect(settle("total_boards_ou", "under", finishedMatch(), 7.5)).toBe("lost");
    expect(settle("total_boards_ou", "under", shortMatch(), 2.5)).toBe("won");
    expect(settle("total_boards_ou", "over", finishedMatch(), 8)).toBe("push");
  });

  it("settles exact boards", () => {
    expect(settle("exact_boards", "8")).toBe("won");
    expect(settle("exact_boards", "7")).toBe("lost");
  });

  it("settles 1UP, 2UP and Never Down from the board history", () => {
    expect(settle("lead_1up", "white")).toBe("won");
    expect(settle("lead_1up", "black")).toBe("lost");
    expect(settle("lead_2up", "white")).toBe("won");
    expect(settle("lead_2up", "black")).toBe("lost");
    expect(settle("lead_never_down", "white")).toBe("won");
    expect(settle("lead_never_down", "black")).toBe("lost");
  });

  it("settles both players winning a board", () => {
    expect(settle("both_win_board", "yes")).toBe("won");
    expect(settle("both_win_board", "no")).toBe("lost");
    expect(settle("both_win_board", "no", shortMatch())).toBe("won");
  });

  it("settles a comeback after losing board one", () => {
    // White took board one and the match, so there was no comeback.
    expect(settle("comeback_board_1", "yes")).toBe("lost");
    expect(settle("comeback_board_1", "no")).toBe("won");
  });

  it("settles board one combined with the match winner", () => {
    expect(settle("board1_match_winner", "white_white")).toBe("won");
    expect(settle("board1_match_winner", "white_black")).toBe("lost");
    expect(settle("board1_match_winner", "black_white")).toBe("lost");
  });

  it("settles total match points", () => {
    expect(settle("total_points", "over", finishedMatch(), 42.5)).toBe("won");
    expect(settle("total_points", "over", finishedMatch(), 43.5)).toBe("lost");
    expect(settle("total_points", "under", finishedMatch(), 43.5)).toBe("won");
  });

  it("settles player points", () => {
    expect(settle("player_points", "over", finishedMatch(), 24.5, "white")).toBe("won");
    expect(settle("player_points", "under", finishedMatch(), 24.5, "white")).toBe("lost");
    expect(settle("player_points", "under", finishedMatch(), 17.5, "black")).toBe("lost");
    expect(settle("player_points", "over", finishedMatch(), 17.5, "black")).toBe("won");
  });

  it("settles board one points", () => {
    expect(settle("board1_points", "over", finishedMatch(), 4.5)).toBe("won");
    expect(settle("board1_points", "under", finishedMatch(), 5.5)).toBe("won");
    expect(settle("board1_points", "over", shortMatch(), 4.5)).toBe("won");
  });

  it("settles the queen markets", () => {
    expect(settle("queen_board1", "white")).toBe("won");
    expect(settle("queen_board1", "black")).toBe("lost");
    expect(settle("queen_board1", "none", shortMatch())).toBe("lost");
    expect(settle("queen_covered", "yes")).toBe("won");
    expect(settle("queen_covered", "no")).toBe("lost");
    expect(settle("queen_wins_board", "yes")).toBe("won");
    expect(settle("queen_first4", "yes")).toBe("won");
    expect(settle("queen_first4", "no")).toBe("lost");
  });

  it("settles the first coin pocketed, player and colour", () => {
    expect(settle("first_coin", "white_own")).toBe("won");
    expect(settle("first_coin", "white_opponent")).toBe("lost");
    expect(settle("first_coin", "black_own")).toBe("lost");
  });

  it("settles coins per player on board one", () => {
    expect(settle("board1_coins", "over", finishedMatch(), 3.5, "white")).toBe("won");
    expect(settle("board1_coins", "under", finishedMatch(), 3.5, "black")).toBe("won");
    expect(settle("board1_coins", "under", shortMatch(), 3.5, "white")).toBe("lost");
  });

  it("settles total fouls, with a push on the line", () => {
    expect(settle("total_fouls", "over", finishedMatch(), 3.5)).toBe("won");
    expect(settle("total_fouls", "under", finishedMatch(), 5.5)).toBe("won");
    expect(settle("total_fouls", "over", finishedMatch(), 5)).toBe("push");
  });

  it("settles who fouled first", () => {
    expect(settle("first_foul", "black")).toBe("won");
    expect(settle("first_foul", "white")).toBe("lost");
  });

  it("settles a foul on board one, per player", () => {
    expect(settle("foul_board1", "yes", finishedMatch(), null, "black")).toBe("won");
    expect(settle("foul_board1", "no", finishedMatch(), null, "white")).toBe("won");
    expect(settle("foul_board1", "yes", finishedMatch(), null, "white")).toBe("lost");
  });

  it("settles a striker pocketed in the match", () => {
    expect(settle("striker_pocket", "yes")).toBe("won");
    expect(settle("striker_pocket", "no")).toBe("lost");
  });

  it("settles a whitewash board", () => {
    expect(settle("whitewash", "yes")).toBe("won");
    expect(settle("whitewash", "no")).toBe("lost");
  });

  it("settles match minutes", () => {
    expect(settle("match_minutes", "over", finishedMatch(), 13.5)).toBe("won");
    expect(settle("match_minutes", "under", finishedMatch(), 15.5)).toBe("won");
    expect(settle("match_minutes", "over", finishedMatch(), 15.5)).toBe("lost");
  });

  it("settles shots in board one", () => {
    expect(settle("board1_shots", "over", finishedMatch(), 20.5)).toBe("won");
    expect(settle("board1_shots", "under", finishedMatch(), 24.5)).toBe("won");
    expect(settle("board1_shots", "over", finishedMatch(), 24.5)).toBe("lost");
  });
});
