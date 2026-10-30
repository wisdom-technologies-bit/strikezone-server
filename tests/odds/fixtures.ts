import type { BoardStats, Colour, MatchStats, PlayerStats } from "../../src/odds/stats.js";

/**
 * Handwritten finished matches, for settling every market against a known
 * result. Nothing here is simulated: a settlement test that runs the simulator
 * cannot tell a wrong rule from an unlucky seed.
 */

const WHITE_BOARDS = new Set([1, 2, 3, 5, 7, 8]);
const BOARD_POINTS: Readonly<Record<number, number>> = {
  1: 5,
  2: 4,
  3: 2,
  4: 9,
  5: 3,
  6: 9,
  7: 5,
  8: 6,
};

function board(index: number, score: Record<Colour, number>): BoardStats {
  const winner: Colour = WHITE_BOARDS.has(index) ? "white" : "black";
  const points = BOARD_POINTS[index] ?? 0;
  score[winner] += points;

  return {
    board: index,
    winner,
    points,
    queenTaker: index === 1 ? "white" : null,
    queenCovered: index === 1,
    queenPoints: index === 1 ? 3 : 0,
    coins: { white: index === 1 ? 4 : 3, black: index === 1 ? 3 : index === 2 ? 0 : 2 },
    fouls: { white: index === 1 ? 0 : 1, black: index === 1 ? 1 : 1 },
    shots: index === 1 ? 22 : 14,
    scoreAfter: { white: score["white"], black: score["black"] },
    leaderAfter:
      score["white"] === score["black"]
        ? "tie"
        : score["white"] > score["black"]
          ? "white"
          : "black",
  };
}

function player(colour: Colour, points: number, boardsWon: number): PlayerStats {
  return {
    colour,
    playerId: colour === "white" ? "player-white" : "player-black",
    displayName: colour === "white" ? "White Hand" : "Black Hand",
    isBot: true,
    points,
    boardsWon,
    coins: colour === "white" ? 38 : 30,
    opponentCoins: colour === "white" ? 1 : 3,
    fouls: colour === "white" ? 2 : 3,
    strikerPockets: colour === "white" ? 1 : 0,
    shots: 60,
    queenTakes: colour === "white" ? 1 : 0,
    queenCovers: colour === "white" ? 1 : 0,
    bestLead: colour === "white" ? 4 : 0,
    everTrailed: colour !== "white",
  };
}

/**
 * A finished match: white 25, black 18, eight boards, white led throughout,
 * queen taken and covered by white on board one, one whitewash board, five
 * fouls, fourteen minutes.
 */
export function finishedMatch(overrides: Partial<MatchStats> = {}): MatchStats {
  const score: Record<Colour, number> = { white: 0, black: 0 };
  const boards = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => board(index, score));

  return {
    matchId: "match-fixture",
    players: { white: player("white", 25, 6), black: player("black", 18, 2) },
    boards,
    boardsPlayed: 8,
    winner: "white",
    totalPoints: 43,
    totalFouls: 5,
    totalShots: 120,
    whitewashBoards: 1,
    firstCoin: { player: "white", coin: "white" },
    firstBoard: null,
    firstFoul: { player: "black", board: 1 },
    strikerPocketed: true,
    queen: { taker: "white", board: 1, covered: true, winsBoard: true, shot: 3 },
    matchMinutes: 14,
    finished: true,
    ...overrides,
  } as MatchStats;
}

/** The same match, called off after one board. */
export function shortMatch(): MatchStats {
  const full = finishedMatch();
  return {
    ...full,
    boards: full.boards.slice(0, 1),
    boardsPlayed: 1,
    players: { white: player("white", 5, 1), black: player("black", 0, 0) },
    totalPoints: 5,
  } as MatchStats;
}

/** A match still in play: every market on it is void. */
export function unfinishedMatch(): MatchStats {
  return { ...finishedMatch(), finished: false, winner: null } as MatchStats;
}

/** A drawn match. */
export function drawnMatch(): MatchStats {
  return { ...finishedMatch(), winner: "tie" } as MatchStats;
}
