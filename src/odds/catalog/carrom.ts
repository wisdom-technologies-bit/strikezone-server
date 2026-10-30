import type { BoardStats, Colour, MatchStats } from "../stats.js";
import { DEFAULT_CARROM_LINES, type CarromLines } from "./lines.js";

/**
 * The Carrom market catalogue.
 *
 * Every market type says three things: which selections it offers (with their
 * lines), whether it stays open in play, and how each selection settles against
 * a finished match. Settlement is a pure function of MatchStats, so a market can
 * be re-settled from the event log at any time and must give the same answer.
 *
 * Nothing here prices anything. That is the pricer's job: it counts how often
 * each selection wins across simulated matches and hands the counts back.
 */

export type Settlement = "won" | "lost" | "push" | "void";

/** How much can be staked: main markets carry the most, niche the least. */
export type StakeTier = "main" | "standard" | "niche";

export interface CatalogSelection {
  readonly key: string;
  readonly name: string;
}

export interface CatalogMarket {
  /** The market type id, for example match_winner. */
  readonly marketType: string;
  /** Which market this is an instance of: a board, a line, a player. */
  readonly subject: string;
  readonly line: number | null;
  readonly name: string;
  /** True when a trader wants it open while the match is running. */
  readonly live: boolean;
  readonly stakeTier: StakeTier;
  readonly selections: readonly CatalogSelection[];
}

export interface CarromCatalog {
  readonly markets: readonly CatalogMarket[];
  settle(
    market: Pick<CatalogMarket, "marketType" | "subject" | "line">,
    key: string,
    stats: MatchStats,
  ): Settlement;
}

const SIDES = [
  { key: "white", name: "White" },
  { key: "black", name: "Black" },
] as const;

const YES_NO = [
  { key: "yes", name: "Yes" },
  { key: "no", name: "No" },
] as const;

const OVER_UNDER = [
  { key: "over", name: "Over" },
  { key: "under", name: "Under" },
] as const;

const OTHER: Readonly<Record<Colour, Colour>> = { white: "black", black: "white" };

/** Finished, or nothing can settle. */
const isOver = (stats: MatchStats): boolean => stats.finished;

/** A board that was actually played, or undefined for one that was not. */
function playedBoard(stats: MatchStats, board: number): BoardStats | undefined {
  return stats.boards.find((entry) => entry.board === board);
}

/** Over/under on a measured number; lines sit on halves so a push is rare. */
function overUnder(value: number, line: number | null, key: string): Settlement {
  if (line === null) {
    return "void";
  }
  if (value === line) {
    return "push";
  }
  const over = value > line;
  return (key === "over") === over ? "won" : "lost";
}

/** Two-way on a measured advantage: white gives the line, so a bigger line is harder. */
function handicap(
  whiteValue: number,
  blackValue: number,
  line: number | null,
  key: string,
): Settlement {
  if (line === null) {
    return "void";
  }
  const margin = whiteValue - blackValue - line;
  if (margin === 0) {
    return "push";
  }
  return (key === "white") === margin > 0 ? "won" : "lost";
}

function band(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** The winner's margin, or null when the match had no winner. */
function winnerColour(stats: MatchStats): Colour | null {
  return stats.winner === "white" || stats.winner === "black" ? stats.winner : null;
}

function marginOf(stats: MatchStats): number | null {
  const winner = winnerColour(stats);
  return winner === null ? null : Math.abs(stats.players.white.points - stats.players.black.points);
}

function loserPoints(stats: MatchStats): number | null {
  const winner = winnerColour(stats);
  return winner === null ? null : stats.players[OTHER[winner]].points;
}

/** First board, when there is one. */
function firstBoard(stats: MatchStats): BoardStats | undefined {
  return playedBoard(stats, 1);
}

function boardWinnerMarket(board: number): CatalogMarket {
  return {
    marketType: "board_winner",
    subject: `board:${String(board)}`,
    line: null,
    name: `Board ${String(board)} winner`,
    live: board === 1,
    stakeTier: board <= 2 ? "standard" : "niche",
    selections: SIDES.map((side) => ({ key: side.key, name: side.name })),
  };
}

function ouMarket(
  marketType: string,
  name: (line: number) => string,
  lines: readonly number[],
  options: { live: boolean; stakeTier: StakeTier; subject?: string },
): CatalogMarket[] {
  return lines.map((line) => ({
    marketType,
    subject: options.subject ?? "",
    line,
    name: name(line),
    live: options.live,
    stakeTier: options.stakeTier,
    selections: OVER_UNDER.map((side) => ({ key: side.key, name: side.name })),
  }));
}

/** Builds the whole catalogue for the configured lines. */
export function carromCatalog(overrides: Partial<CarromLines> = {}): CarromCatalog {
  const lines: CarromLines = { ...DEFAULT_CARROM_LINES, ...overrides };
  const markets: CatalogMarket[] = [];

  // 1. Match winner.
  markets.push({
    marketType: "match_winner",
    subject: "",
    line: null,
    name: "Match winner",
    live: true,
    stakeTier: "main",
    selections: SIDES.map((side) => ({ key: side.key, name: side.name })),
  });

  // 2. Board winner, one market per board.
  for (const board of lines.boardWinnerBoards) {
    markets.push(boardWinnerMarket(board));
  }

  // 3. Points handicap.
  for (const line of lines.pointsHandicap) {
    markets.push({
      marketType: "points_handicap",
      subject: "points",
      line,
      name: `Points handicap ${line.toFixed(1)}`,
      live: false,
      stakeTier: "main",
      selections: SIDES.map((side) => ({ key: side.key, name: `${side.name} ${line.toFixed(1)}` })),
    });
  }

  // 4. Boards handicap.
  for (const line of lines.boardsHandicap) {
    markets.push({
      marketType: "boards_handicap",
      subject: "boards",
      line,
      name: `Boards handicap ${line.toFixed(1)}`,
      live: false,
      stakeTier: "standard",
      selections: SIDES.map((side) => ({ key: side.key, name: `${side.name} ${line.toFixed(1)}` })),
    });
  }

  // 5. Winning margin bands.
  markets.push({
    marketType: "winning_margin",
    subject: "",
    line: null,
    name: "Winning margin",
    live: false,
    stakeTier: "standard",
    selections: lines.marginBands.map(([min, max]) => ({
      key: `${String(min)}-${String(max)}`,
      name: max >= 99 ? `${String(min)}+` : `${String(min)}-${String(max)}`,
    })),
  });

  // 6. Loser's final score bands.
  markets.push({
    marketType: "loser_score",
    subject: "",
    line: null,
    name: "Loser's score",
    live: false,
    stakeTier: "standard",
    selections: lines.loserScoreBands.map(([min, max]) => ({
      key: `${String(min)}-${String(max)}`,
      name: `${String(min)}-${String(max)}`,
    })),
  });

  // 7. Total boards, over/under.
  markets.push(
    ...ouMarket("total_boards_ou", (line) => `Total boards ${line.toFixed(1)}`, lines.totalBoards, {
      live: true,
      stakeTier: "standard",
    }),
  );

  // 8. Exact number of boards.
  markets.push({
    marketType: "exact_boards",
    subject: "",
    line: null,
    name: "Exact boards",
    live: false,
    stakeTier: "niche",
    selections: lines.exactBoards.map((board) => ({
      key: String(board),
      name: `${String(board)} boards`,
    })),
  });

  // 9. Lead markets: 1UP, 2UP, Never Down.
  for (const [marketType, name] of [
    ["lead_1up", "1UP"],
    ["lead_2up", "2UP"],
    ["lead_never_down", "Never Down"],
  ] as const) {
    markets.push({
      marketType,
      subject: "",
      line: null,
      name,
      live: true,
      stakeTier: "standard",
      selections: SIDES.map((side) => ({ key: side.key, name: side.name })),
    });
  }

  // 10. Both players win a board.
  markets.push({
    marketType: "both_win_board",
    subject: "",
    line: null,
    name: "Both players win a board",
    live: true,
    stakeTier: "standard",
    selections: YES_NO.map((side) => ({ key: side.key, name: side.name })),
  });

  // 11. Comeback after losing board one.
  markets.push({
    marketType: "comeback_board_1",
    subject: "",
    line: null,
    name: "Comeback: board one loser wins the match",
    live: true,
    stakeTier: "standard",
    selections: YES_NO.map((side) => ({ key: side.key, name: side.name })),
  });

  // 12. Board one winner and match winner.
  markets.push({
    marketType: "board1_match_winner",
    subject: "",
    line: null,
    name: "Board 1 winner and match winner",
    live: false,
    stakeTier: "niche",
    selections: [
      { key: "white_white", name: "White board 1, White match" },
      { key: "white_black", name: "White board 1, Black match" },
      { key: "black_white", name: "Black board 1, White match" },
      { key: "black_black", name: "Black board 1, Black match" },
    ],
  });

  // 13. Total match points.
  markets.push(
    ...ouMarket("total_points", (line) => `Total points ${line.toFixed(1)}`, lines.totalPoints, {
      live: true,
      stakeTier: "main",
    }),
  );

  // 14. Player points, six lines each.
  for (const side of SIDES) {
    markets.push(
      ...ouMarket(
        "player_points",
        (line) => `${side.name} points ${line.toFixed(1)}`,
        lines.playerPoints,
        { live: true, stakeTier: "standard", subject: side.key },
      ),
    );
  }

  // 15. Board one points.
  markets.push(
    ...ouMarket(
      "board1_points",
      (line) => `Board 1 points ${line.toFixed(1)}`,
      lines.boardOnePoints,
      {
        live: true,
        stakeTier: "standard",
      },
    ),
  );

  // 16. Queen taker on board one.
  markets.push({
    marketType: "queen_board1",
    subject: "",
    line: null,
    name: "Queen taker, board 1",
    live: true,
    stakeTier: "standard",
    selections: [
      { key: "white", name: "White" },
      { key: "black", name: "Black" },
      { key: "none", name: "No queen" },
    ],
  });

  // 17. Queen covered.
  markets.push({
    marketType: "queen_covered",
    subject: "",
    line: null,
    name: "Queen covered",
    live: true,
    stakeTier: "standard",
    selections: YES_NO.map((side) => ({ key: side.key, name: side.name })),
  });

  // 18. Queen taker also wins that board.
  markets.push({
    marketType: "queen_wins_board",
    subject: "",
    line: null,
    name: "Queen taker also wins the board",
    live: true,
    stakeTier: "standard",
    selections: YES_NO.map((side) => ({ key: side.key, name: side.name })),
  });

  // 19. Queen pocketed in the first four shots.
  markets.push({
    marketType: "queen_first4",
    subject: "",
    line: null,
    name: "Queen pocketed in the first 4 shots",
    live: false,
    stakeTier: "niche",
    selections: YES_NO.map((side) => ({ key: side.key, name: side.name })),
  });

  // 20. First coin pocketed: who, and whose coin.
  markets.push({
    marketType: "first_coin",
    subject: "",
    line: null,
    name: "First coin pocketed",
    live: false,
    stakeTier: "niche",
    selections: [
      { key: "white_own", name: "White pockets white" },
      { key: "white_opponent", name: "White pockets black" },
      { key: "black_own", name: "Black pockets black" },
      { key: "black_opponent", name: "Black pockets white" },
    ],
  });

  // 21. Coins per player on board one.
  for (const side of SIDES) {
    markets.push(
      ...ouMarket(
        "board1_coins",
        (line) => `${side.name} coins board 1 ${line.toFixed(1)}`,
        lines.boardOneCoins,
        { live: true, stakeTier: "standard", subject: side.key },
      ),
    );
  }

  // 22. Total fouls.
  markets.push(
    ...ouMarket("total_fouls", (line) => `Total fouls ${line.toFixed(1)}`, lines.totalFouls, {
      live: true,
      stakeTier: "standard",
    }),
  );

  // 23. First foul.
  markets.push({
    marketType: "first_foul",
    subject: "",
    line: null,
    name: "First foul",
    live: false,
    stakeTier: "niche",
    selections: [
      { key: "white", name: "White" },
      { key: "black", name: "Black" },
      { key: "none", name: "No foul" },
    ],
  });

  // 24. A foul in board one, per player.
  for (const side of SIDES) {
    markets.push({
      marketType: "foul_board1",
      subject: side.key,
      line: null,
      name: `${side.name} fouls in board 1`,
      live: true,
      stakeTier: "niche",
      selections: YES_NO.map((entry) => ({ key: entry.key, name: entry.name })),
    });
  }

  // 25. A striker pocketed at any point.
  markets.push({
    marketType: "striker_pocket",
    subject: "",
    line: null,
    name: "Striker pocketed in the match",
    live: true,
    stakeTier: "standard",
    selections: YES_NO.map((side) => ({ key: side.key, name: side.name })),
  });

  // 26. Whitewash board.
  markets.push({
    marketType: "whitewash",
    subject: "",
    line: null,
    name: "Whitewash board",
    live: true,
    stakeTier: "standard",
    selections: YES_NO.map((side) => ({ key: side.key, name: side.name })),
  });

  // 27. Match minutes.
  markets.push(
    ...ouMarket("match_minutes", (line) => `Match minutes ${line.toFixed(1)}`, lines.matchMinutes, {
      live: false,
      stakeTier: "standard",
    }),
  );

  // 28. Shots in board one.
  markets.push(
    ...ouMarket("board1_shots", (line) => `Board 1 shots ${line.toFixed(1)}`, lines.boardOneShots, {
      live: true,
      stakeTier: "niche",
    }),
  );

  return { markets, settle: settleWith };
}

/**
 * How one selection settles.
 *
 * Void means the market could not be decided: an unfinished match, a board that
 * was never played, a match with no winner. A bettor's stake goes back, which is
 * the only defensible answer when the event the market describes never happened.
 */
function settleWith(
  market: Pick<CatalogMarket, "marketType" | "subject" | "line">,
  key: string,
  stats: MatchStats,
): Settlement {
  if (!isOver(stats)) {
    return "void";
  }

  const winner = winnerColour(stats);
  const white = stats.players.white;
  const black = stats.players.black;
  const boardOne = firstBoard(stats);

  switch (market.marketType) {
    case "match_winner": {
      if (winner === null) {
        return "void";
      }
      return key === winner ? "won" : "lost";
    }

    case "board_winner": {
      const board = Number(market.subject.replace("board:", ""));
      const played = playedBoard(stats, board);
      if (played === undefined || played.winner === null) {
        return "void";
      }
      return key === played.winner ? "won" : "lost";
    }

    case "points_handicap":
      return handicap(white.points, black.points, market.line, key);

    case "boards_handicap":
      return handicap(white.boardsWon, black.boardsWon, market.line, key);

    case "winning_margin": {
      const margin = marginOf(stats);
      if (margin === null) {
        return "void";
      }
      const [min, max] = key.split("-").map(Number) as [number, number];
      return band(margin, min, max) ? "won" : "lost";
    }

    case "loser_score": {
      const score = loserPoints(stats);
      if (score === null) {
        return "void";
      }
      const [min, max] = key.split("-").map(Number) as [number, number];
      return band(score, min, max) ? "won" : "lost";
    }

    case "total_boards_ou":
      return overUnder(stats.boardsPlayed, market.line, key);

    case "exact_boards":
      return stats.boardsPlayed === Number(key) ? "won" : "lost";

    case "lead_1up": {
      const player = key === "white" ? white : black;
      return player.bestLead >= 1 ? "won" : "lost";
    }

    case "lead_2up": {
      const player = key === "white" ? white : black;
      return player.bestLead >= 2 ? "won" : "lost";
    }

    case "lead_never_down": {
      const player = key === "white" ? white : black;
      return player.everTrailed ? "lost" : "won";
    }

    case "both_win_board": {
      const both = white.boardsWon > 0 && black.boardsWon > 0;
      return (key === "yes") === both ? "won" : "lost";
    }

    case "comeback_board_1": {
      if (boardOne === undefined || boardOne.winner === null || winner === null) {
        return "void";
      }
      const cameBack = boardOne.winner !== winner;
      return (key === "yes") === cameBack ? "won" : "lost";
    }

    case "board1_match_winner": {
      if (boardOne === undefined || boardOne.winner === null || winner === null) {
        return "void";
      }
      return key === `${boardOne.winner}_${winner}` ? "won" : "lost";
    }

    case "total_points":
      return overUnder(stats.totalPoints, market.line, key);

    case "player_points": {
      const player = market.subject === "black" ? black : white;
      return overUnder(player.points, market.line, key);
    }

    case "board1_points": {
      if (boardOne === undefined || boardOne.winner === null) {
        return "void";
      }
      return overUnder(boardOne.points, market.line, key);
    }

    case "queen_board1": {
      if (boardOne === undefined) {
        return "void";
      }
      if (boardOne.queenTaker === null) {
        return key === "none" ? "won" : "lost";
      }
      return key === boardOne.queenTaker ? "won" : "lost";
    }

    case "queen_covered": {
      const queen = stats.queen;
      if (queen === null) {
        return key === "no" ? "won" : "lost";
      }
      return (key === "yes") === queen.covered ? "won" : "lost";
    }

    case "queen_wins_board": {
      const queen = stats.queen;
      if (queen === null) {
        return "void";
      }
      return (key === "yes") === queen.winsBoard ? "won" : "lost";
    }

    case "queen_first4": {
      const queen = stats.queen;
      if (queen === null) {
        return key === "no" ? "won" : "lost";
      }
      return (key === "yes") === queen.shot <= 4 ? "won" : "lost";
    }

    case "first_coin": {
      const first = stats.firstCoin;
      if (first === null) {
        return "void";
      }
      const own = first.coin === first.player;
      return key === `${first.player}_${own ? "own" : "opponent"}` ? "won" : "lost";
    }

    case "board1_coins": {
      if (boardOne === undefined) {
        return "void";
      }
      const player = market.subject === "black" ? "black" : "white";
      return overUnder(boardOne.coins[player], market.line, key);
    }

    case "total_fouls":
      return overUnder(stats.totalFouls, market.line, key);

    case "first_foul": {
      const first = stats.firstFoul;
      if (first === null) {
        return key === "none" ? "won" : "lost";
      }
      return key === first.player ? "won" : "lost";
    }

    case "foul_board1": {
      if (boardOne === undefined) {
        return "void";
      }
      const player = market.subject === "black" ? "black" : "white";
      const fouled = boardOne.fouls[player] > 0;
      return (key === "yes") === fouled ? "won" : "lost";
    }

    case "striker_pocket": {
      const pockets = white.strikerPockets + black.strikerPockets;
      return (key === "yes") === pockets > 0 ? "won" : "lost";
    }

    case "whitewash":
      return (key === "yes") === stats.whitewashBoards > 0 ? "won" : "lost";

    case "match_minutes":
      return overUnder(stats.matchMinutes, market.line, key);

    case "board1_shots": {
      if (boardOne === undefined) {
        return "void";
      }
      return overUnder(boardOne.shots, market.line, key);
    }

    default:
      return "void";
  }
}
