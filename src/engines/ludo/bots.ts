/**
 * The three Ludo policies.
 *
 * Each is a {@link LudoChooser}: given the board, the roll and the legal moves, it
 * returns one of them. Ties are broken by the order `getLegalMoves` produced, so a
 * policy is deterministic, and none of them reads anything but the board.
 *
 * Informed by reading public discussions of Ludo bot strategies for the three
 * archetypes named in the brief. This code is original.
 */

import { LUDO_GEOMETRY, isSafeCell, ringCellOf } from "./config.js";
import { progressOf, remainingTokens } from "./rules.js";
import { LUDO_HOME, LUDO_YARD, type LudoChooser, type LudoMove, type LudoState } from "./types.js";
import type { LudoBotId } from "./bot-config.js";

/** How far behind a token an opponent can be and still reach it next roll. */
const DANGER_RANGE = 6;

/**
 * True when an opponent could land on this ring cell with one roll.
 *
 * A safe cell is never dangerous, and neither is a cell inside a home column or a
 * finished token: nothing can capture there.
 */
export function isCellDangerous(state: LudoState, seat: number, cell: number): boolean {
  if (cell < 0 || isSafeCell(cell)) {
    return false;
  }

  for (const other of state.seats) {
    if (other === seat) {
      continue;
    }
    for (let token = 0; token < state.config.tokensPerPlayer; token += 1) {
      const progress = progressOf(state, other, token);
      if (progress < 0 || progress > LUDO_GEOMETRY.ringSteps - 1) {
        continue;
      }
      const opponentCell = ringCellOf(other, progress);
      if (opponentCell === null) {
        continue;
      }
      // Distance ahead from the opponent to this cell, along the ring.
      const gap = (cell - opponentCell + LUDO_GEOMETRY.ringCells) % LUDO_GEOMETRY.ringCells;
      if (gap >= 1 && gap <= DANGER_RANGE) {
        return true;
      }
    }
  }

  return false;
}

/** The ring cell a move lands on, or -1 when it lands in a home column. */
function landingCell(seat: number, move: LudoMove): number {
  const cell = ringCellOf(seat, move.to);
  return cell === null ? -1 : cell;
}

/** True when the token this move touches is currently in danger. */
function isFleeing(state: LudoState, move: LudoMove): boolean {
  if (move.from < 0 || move.from > LUDO_GEOMETRY.ringSteps - 1) {
    return false;
  }
  const cell = ringCellOf(move.seat, move.from);
  return cell !== null && isCellDangerous(state, move.seat, cell);
}

/** True when the move's landing square cannot be captured on. */
function landsSafely(state: LudoState, move: LudoMove): boolean {
  if (move.to >= LUDO_GEOMETRY.ringSteps) {
    return true; // home column or home: nothing can reach it
  }
  const cell = landingCell(move.seat, move);
  return cell >= 0 && !isCellDangerous(state, move.seat, cell);
}

/**
 * Cautious: protect what it has.
 *
 * Order of preference: a move that takes a token out of danger, then a move into
 * the home column or home, then a move onto a safe or unreachable square, then
 * bringing a token out on a 6, then the token closest to home.
 */
export const cautiousChooser: LudoChooser = (state, _roll, moves) => {
  const score = (move: LudoMove): number => {
    let points = 0;
    if (isFleeing(state, move)) {
      points += 60;
    }
    if (move.to === LUDO_HOME) {
      points += 55;
    }
    if (move.to >= LUDO_GEOMETRY.ringSteps) {
      points += 45;
    }
    if (landsSafely(state, move)) {
      points += 30;
    }
    if (move.kind === "enter") {
      points += 20;
    }
    if (move.captures.length > 0) {
      points += 10;
    }
    // Prefer the token that is furthest along, so the board empties in order.
    points += move.to / (LUDO_GEOMETRY.homeProgress + 1);
    return points;
  };

  return pickBest(moves, score);
};

/**
 * Aggressive: hunt.
 *
 * Order of preference: the capture that sends back the token nearest home, then any
 * capture, then finishing a token, then the furthest token.
 */
export const aggressiveChooser: LudoChooser = (state, _roll, moves) => {
  const furthestCaptured = (move: LudoMove): number => {
    let furthest = -1;
    for (const index of move.captures) {
      const seat = Math.floor(index / state.config.tokensPerPlayer);
      const token = index % state.config.tokensPerPlayer;
      furthest = Math.max(furthest, progressOf(state, seat, token));
    }
    return furthest;
  };

  const score = (move: LudoMove): number => {
    let points = move.captures.length * 100;
    points += furthestCaptured(move) / 2;
    if (move.to === LUDO_HOME) {
      points += 40;
    }
    if (move.to >= LUDO_GEOMETRY.ringSteps) {
      points += 25;
    }
    if (move.kind === "enter") {
      points += 15;
    }
    points += move.to / (LUDO_GEOMETRY.homeProgress + 1);
    return points;
  };

  return pickBest(moves, score);
};

/**
 * Racer: always the front token.
 *
 * The front token is the one with the most progress, so "advance the front" is a
 * move with the highest `to`. A finish always beats an advance.
 */
export const racerChooser: LudoChooser = (_state, _roll, moves) => {
  const score = (move: LudoMove): number => {
    let points = move.to;
    if (move.to === LUDO_HOME) {
      points += 100;
    }
    if (move.kind === "enter") {
      points += 5; // a token in the yard is never the front token
    }
    return points;
  };

  return pickBest(moves, score);
};

/** The highest-scoring move, first one wins a tie. */
function pickBest(moves: readonly LudoMove[], score: (move: LudoMove) => number): LudoMove {
  let best = moves[0];
  if (best === undefined) {
    throw new Error("a chooser was asked to pick from no moves");
  }
  let bestScore = score(best);

  for (let index = 1; index < moves.length; index += 1) {
    const candidate = moves[index];
    if (candidate === undefined) {
      continue;
    }
    const candidateScore = score(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }

  return best;
}

/** The chooser for one policy id. */
export function chooserFor(policy: LudoBotId): LudoChooser {
  switch (policy) {
    case "cautious":
      return cautiousChooser;
    case "aggressive":
      return aggressiveChooser;
    case "racer":
      return racerChooser;
    default:
      return cautiousChooser;
  }
}

/** How many tokens this seat still has to bring home, exposed for the APIs. */
export function tokensToHome(state: LudoState, seat: number): number {
  return remainingTokens(state, seat);
}

export { LUDO_YARD };
