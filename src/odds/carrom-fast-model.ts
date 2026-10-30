import { createSeededRng, type SeededRng } from "../lib/fair-rng.js";
import { SHOT_TABLE as SHOT_TABLE_SAFE, pocketChance } from "./shot-table.js";
import type { BoardStats, Colour, MatchStats, PlayerStats } from "./stats.js";

/**
 * A match without physics.
 *
 * The real engine resolves collisions at 240 Hz; this resolves a shot with one
 * number drawn from the calibrated shot table. That is the whole trade: a
 * hundred thousand matches in the seconds a price is allowed to take, against a
 * few hundred a minute for the real thing.
 *
 * Every draw comes from the seeded generator in src/lib/fair-rng.ts, so a price
 * can be reproduced exactly from its seed.
 */

export interface FastSkill {
  readonly aimErrorDegrees: number;
  readonly selectionQuality: number;
  readonly foulRate: number;
}

export interface FastPlayer {
  readonly playerId: string;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly skill: FastSkill;
}

export interface FastMatchOptions {
  readonly matchId: string;
  readonly seed: string;
  readonly white: FastPlayer;
  readonly black: FastPlayer;
  readonly pointsToWin?: number;
  readonly boardsPerMatch?: number;
  readonly coinsPerSide?: number;
  readonly queenPoints?: number;
  /** Seconds a shot is assumed to take, for the match-minutes markets. */
  readonly secondsPerShot?: number;
}

const OTHER: Readonly<Record<Colour, Colour>> = { white: "black", black: "white" };

/** Share of boards that swing against the run of play. */
const FLUKE_RATE = 0.16;

/**
 * How the table is read for a given board state.
 *
 * With many coins on the board there is usually one near a pocket and a short
 * line to play; as the board empties every remaining coin is further away and
 * the cut needed is finer. That is the only structural assumption here, and it
 * is what the calibration sweep measures.
 */
export function shotGeometry(coinsOnBoard: number): { distanceMm: number; cutDegrees: number } {
  const scarcity = Math.min(1, Math.max(0, (18 - coinsOnBoard) / 16));
  return { distanceMm: 60 + scarcity * 200, cutDegrees: 10 + scarcity * 45 };
}

/** Chance the shooter pots a coin on this shot, from the table. */
export function potChance(skill: FastSkill, coinsOnBoard: number): number {
  const { distanceMm, cutDegrees } = shotGeometry(coinsOnBoard);
  const base = pocketChance(SHOT_TABLE_SAFE, skill.aimErrorDegrees, distanceMm, cutDegrees);
  // Selection quality is how well a player picks the shot in front of them; a
  // poor chooser wastes good hands.
  return Math.min(0.85, base * (0.75 + 0.25 * skill.selectionQuality));
}

/** Plays one whole match and returns the stats a market settles against. */
export function simulateFastMatch(options: FastMatchOptions): MatchStats {
  const pointsToWin = options.pointsToWin ?? 25;
  const boardsPerMatch = options.boardsPerMatch ?? 8;
  const coinsPerSide = options.coinsPerSide ?? 9;
  const queenPoints = options.queenPoints ?? 3;
  const secondsPerShot = options.secondsPerShot ?? 6;

  const rng: SeededRng = createSeededRng(`${options.seed}:${options.matchId}`);

  const skills: Record<Colour, FastSkill> = {
    white: options.white.skill,
    black: options.black.skill,
  };

  const score: Record<Colour, number> = { white: 0, black: 0 };
  const boardsWon: Record<Colour, number> = { white: 0, black: 0 };
  const coins: Record<Colour, number> = { white: 0, black: 0 };
  const opponentCoins: Record<Colour, number> = { white: 0, black: 0 };
  const fouls: Record<Colour, number> = { white: 0, black: 0 };
  const shots: Record<Colour, number> = { white: 0, black: 0 };
  const bestLead: Record<Colour, number> = { white: 0, black: 0 };
  const everTrailed: Record<Colour, boolean> = { white: false, black: false };
  const queenTakes: Record<Colour, number> = { white: 0, black: 0 };
  const queenCovers: Record<Colour, number> = { white: 0, black: 0 };

  const boards: BoardStats[] = [];
  let totalShots = 0;
  let firstCoin: MatchStats["firstCoin"] = null;
  let firstFoul: MatchStats["firstFoul"] = null;
  let strikerPocketed = false;
  let queen: MatchStats["queen"] = null;
  let queenCoveredBoard: number | null = null;
  let whitewashBoards = 0;
  let winner: MatchStats["winner"] = null;
  let turn: Colour = "white";

  for (let board = 1; board <= boardsPerMatch; board += 1) {
    if (score.white >= pointsToWin || score.black >= pointsToWin) {
      break;
    }

    const left: Record<Colour, number> = { white: coinsPerSide, black: coinsPerSide };
    const boardCoins: Record<Colour, number> = { white: 0, black: 0 };
    const boardFouls: Record<Colour, number> = { white: 0, black: 0 };
    let boardShots = 0;
    let queenOnBoard = true;
    let queenPocketedBy: Colour | null = null;
    let queenCovered = false;
    let boardWinner: Colour | null = null;
    let boardPoints = 0;
    let boardQueenPoints = 0;

    // A safety valve: a board that never ends would hang the price.
    for (let shot = 0; shot < 400 && boardWinner === null; shot += 1) {
      boardShots += 1;
      totalShots += 1;
      shots[turn] += 1;
      const skill = skills[turn];
      const coinsOnBoard = left.white + left.black + (queenOnBoard ? 1 : 0);

      if (rng.nextFloat() < skill.foulRate) {
        fouls[turn] += 1;
        boardFouls[turn] += 1;
        if (rng.nextFloat() < 0.35) {
          strikerPocketed = true;
        }
        if (firstFoul === null) {
          firstFoul = { player: turn, board };
        }
        turn = OTHER[turn];
        continue;
      }

      const potted = rng.nextFloat() < potChance(skill, coinsOnBoard);

      if (!potted) {
        turn = OTHER[turn];
        continue;
      }

      // A pot: the queen if it is there and the draw says so, otherwise a coin.
      const takesQueen = queenOnBoard && rng.nextFloat() < 0.18;
      if (takesQueen) {
        queenOnBoard = false;
        queenPocketedBy = turn;
        queenTakes[turn] += 1;
        if (queen === null) {
          queen = { taker: turn, board, covered: false, winsBoard: false, shot: totalShots };
        }
      } else if (queenPocketedBy === turn && !queenCovered && rng.nextFloat() < 0.55) {
        queenCovered = true;
        queenCoveredBoard = board;
        queenCovers[turn] += 1;
      } else if (left[turn] > 0) {
        left[turn] -= 1;
        coins[turn] += 1;
        boardCoins[turn] += 1;
        if (firstCoin === null) {
          firstCoin = { player: turn, coin: turn };
        }
      }

      // Covering the queen takes a coin with it in the real game; the model
      // spends one here too, so the count still reaches zero.
      if (
        left[turn] === 0 ||
        (left[turn] === 1 && queenCovered && boardCoins[turn] >= coinsPerSide - 1)
      ) {
        boardWinner = turn;
        boardPoints = left[OTHER[turn]];
        if (queenCovered && queenPocketedBy === turn) {
          boardQueenPoints = queenPoints;
        }
        boardPoints += boardQueenPoints;
      }
    }

    if (boardWinner === null) {
      // The safety valve tripped: whoever has fewer coins left takes the board.
      boardWinner = left.white <= left.black ? "white" : "black";
      boardPoints =
        left[OTHER[boardWinner]] +
        (queenCovered && queenPocketedBy === boardWinner ? queenPoints : 0);
      boardQueenPoints = queenCovered && queenPocketedBy === boardWinner ? queenPoints : 0;
    }

    if (rng.nextFloat() < FLUKE_RATE) {
      // A board can swing on a single queen-and-cover. Without this the model
      // sends the better player to a near-certain win, which no real board does.
      boardWinner = OTHER[boardWinner];
      boardPoints =
        left[OTHER[boardWinner]] +
        (queenCovered && queenPocketedBy === boardWinner ? queenPoints : 0);
      boardQueenPoints = queenCovered && queenPocketedBy === boardWinner ? queenPoints : 0;
    }

    score[boardWinner] += boardPoints;
    boardsWon[boardWinner] += 1;
    if (boardCoins[OTHER[boardWinner]] === 0) {
      whitewashBoards += 1;
    }

    const lead = boardsWon.white - boardsWon.black;
    bestLead.white = Math.max(bestLead.white, lead);
    bestLead.black = Math.max(bestLead.black, -lead);
    if (lead < 0) {
      everTrailed.white = true;
    }
    if (lead > 0) {
      everTrailed.black = true;
    }

    boards.push({
      board,
      winner: boardWinner,
      points: boardPoints,
      queenTaker: queenPocketedBy,
      queenCovered,
      queenPoints: boardQueenPoints,
      coins: { ...boardCoins },
      fouls: { ...boardFouls },
      shots: boardShots,
      scoreAfter: { ...score },
      leaderAfter: lead > 0 ? "white" : lead < 0 ? "black" : "tie",
    });

    turn = OTHER[boardWinner];

    if (score[boardWinner] >= pointsToWin) {
      winner = boardWinner;
      break;
    }
    if (board === boardsPerMatch) {
      winner = score.white === score.black ? "tie" : score.white > score.black ? "white" : "black";
    }
  }

  if (winner === null) {
    winner = score.white === score.black ? "tie" : score.white > score.black ? "white" : "black";
  }

  const finalQueen = queen;
  if (finalQueen !== null) {
    const decided = boards.find((entry) => entry.board === finalQueen.board);
    queen = {
      taker: finalQueen.taker,
      board: finalQueen.board,
      covered: queenCoveredBoard === finalQueen.board,
      winsBoard: decided !== undefined && decided.winner === finalQueen.taker,
      shot: finalQueen.shot,
    };
  }

  const player = (colour: Colour, player_: FastPlayer): PlayerStats => ({
    colour,
    playerId: player_.playerId,
    displayName: player_.displayName,
    isBot: player_.isBot,
    points: score[colour],
    boardsWon: boardsWon[colour],
    coins: coins[colour],
    opponentCoins: opponentCoins[colour],
    fouls: fouls[colour],
    strikerPockets: 0,
    shots: shots[colour],
    queenTakes: queenTakes[colour],
    queenCovers: queenCovers[colour],
    bestLead: bestLead[colour],
    everTrailed: everTrailed[colour],
  });

  return {
    matchId: options.matchId,
    players: { white: player("white", options.white), black: player("black", options.black) },
    boards,
    boardsPlayed: boards.length,
    winner,
    totalPoints: score.white + score.black,
    totalFouls: fouls.white + fouls.black,
    totalShots,
    whitewashBoards,
    firstCoin,
    firstFoul,
    strikerPocketed,
    queen,
    matchMinutes: (totalShots * secondsPerShot) / 60,
    finished: true,
  };
}
