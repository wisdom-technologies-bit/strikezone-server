/**
 * The Ludo referee: legal moves, applied moves, captures, the home column and the
 * turn cycle.
 *
 * Every function here is pure. `applyMove` returns a new state and the events that
 * took it there; nothing is mutated, so a caller can hold the old state, broadcast
 * the new one, and replay from either.
 *
 * Informed by reading public Ludo rule sets for turn order, the yard and safe
 * squares. This code is original.
 */

import {
  LUDO_GEOMETRY,
  isSafeCell,
  resolveLudoConfig,
  ringCellOf,
  seatsOf,
  type LudoConfig,
} from "./config.js";
import {
  LUDO_HOME,
  LUDO_YARD,
  type LudoChooser,
  type LudoEvent,
  type LudoMove,
  type LudoOutcome,
  type LudoState,
} from "./types.js";
import type { UniformRng } from "../../lib/fair-rng.js";

/** The face of a die, uniform from 1 to `sides`. */
export function rollDie(rng: UniformRng, sides = 6): number {
  return 1 + Math.floor(rng.nextFloat() * sides);
}

/** A fresh game, every token in its yard, the first seat to roll. */
export function createInitialState(config: Partial<LudoConfig> = {}): LudoState {
  const resolved = resolveLudoConfig(config);
  const tokens: number[] = [];
  for (let index = 0; index < resolved.players * resolved.tokensPerPlayer; index += 1) {
    tokens.push(LUDO_YARD);
  }

  return {
    config: resolved,
    seats: seatsOf(resolved),
    tokens,
    turn: 0,
    sixes: 0,
    rolls: 0,
    finishingOrder: [],
    status: "playing",
  };
}

/** The flat index of one token. */
export function tokenIndex(config: LudoConfig, seat: number, token: number): number {
  return seat * config.tokensPerPlayer + token;
}

/** One token's progress. */
export function progressOf(state: LudoState, seat: number, token: number): number {
  return state.tokens[tokenIndex(state.config, seat, token)] ?? LUDO_YARD;
}

/** The seat whose turn it is. */
export function seatToPlay(state: LudoState): number {
  return state.seats[state.turn] ?? 0;
}

/** How many of this seat's tokens are home. */
export function homeCount(state: LudoState, seat: number): number {
  const { tokensPerPlayer } = state.config;
  let home = 0;
  for (let token = 0; token < tokensPerPlayer; token += 1) {
    if (progressOf(state, seat, token) === LUDO_HOME) {
      home += 1;
    }
  }
  return home;
}

/** True when every token of this seat is home. */
export function isPlayerFinished(state: LudoState, seat: number): boolean {
  return homeCount(state, seat) === state.config.tokensPerPlayer;
}

/** How many tokens this seat still has on the board or in its yard. */
export function remainingTokens(state: LudoState, seat: number): number {
  return state.config.tokensPerPlayer - homeCount(state, seat);
}

/**
 * The ring cell a token stands on, or -1 when it is not on the ring at all.
 *
 * Kept as a number, not null, because it is compared in the hot path.
 */
function ringCellOfToken(seat: number, progress: number): number {
  const cell = ringCellOf(seat, progress);
  return cell === null ? -1 : cell;
}

/** How many tokens of each seat stand on one ring cell, and how many of them are the mover's. */
interface Occupancy {
  readonly own: number;
  readonly opponents: number;
  readonly opponentSeats: number[];
  readonly opponentTokens: number[];
}

/** Who is standing on a ring cell. Costs one pass over the tokens, no allocation beyond two small arrays. */
function occupancyOf(state: LudoState, seat: number, cell: number): Occupancy {
  let own = 0;
  let opponents = 0;
  const opponentSeats: number[] = [];
  const opponentTokens: number[] = [];

  for (const other of state.seats) {
    for (let token = 0; token < state.config.tokensPerPlayer; token += 1) {
      const progress = progressOf(state, other, token);
      if (progress < 0 || progress > LUDO_GEOMETRY.ringSteps - 1) {
        continue;
      }
      if (ringCellOfToken(other, progress) !== cell) {
        continue;
      }
      if (other === seat) {
        own += 1;
      } else {
        opponents += 1;
        opponentSeats.push(other);
        opponentTokens.push(token);
      }
    }
  }

  return { own, opponents, opponentSeats, opponentTokens };
}

/**
 * The tokens a landing would send back to the yard.
 *
 * Empty on a safe cell, and empty when the square holds a block the mover may not
 * land on at all: in that case the move is not legal, which `getLegalMoves` checks
 * before calling this.
 */
function capturesAt(state: LudoState, seat: number, cell: number): number[] {
  if (isSafeCell(cell)) {
    return [];
  }

  const occupancy = occupancyOf(state, seat, cell);
  if (occupancy.opponents === 0) {
    return [];
  }

  const captured: number[] = [];
  for (let index = 0; index < occupancy.opponents; index += 1) {
    const opponentSeat = occupancy.opponentSeats[index] ?? 0;
    const opponentToken = occupancy.opponentTokens[index] ?? 0;
    captured.push(tokenIndex(state.config, opponentSeat, opponentToken));
  }
  return captured;
}

/**
 * Every move this seat may make with this roll.
 *
 * The order is stable (token order, then entering before advancing), because bots
 * break ties by taking the first move that suits them and a stable order is part
 * of the engine's determinism.
 */
export function getLegalMoves(state: LudoState, roll: number): LudoMove[] {
  const seat = seatToPlay(state);
  const moves: LudoMove[] = [];

  if (state.status === "finished" || roll < 1 || roll > state.config.diceSides) {
    return moves;
  }

  const { tokensPerPlayer, stacking } = state.config;
  const leavingYard = roll === state.config.diceSides;

  for (let token = 0; token < tokensPerPlayer; token += 1) {
    const from = progressOf(state, seat, token);

    if (from === LUDO_YARD) {
      if (!leavingYard) {
        continue;
      }

      const startCell = ringCellOfToken(seat, 0);
      const occupancy = occupancyOf(state, seat, startCell);
      if (stacking === "block" && occupancy.opponents >= 2) {
        continue;
      }

      moves.push({
        seat,
        token,
        roll,
        from,
        to: 0,
        kind: "enter",
        captures: capturesAt(state, seat, startCell),
      });
      continue;
    }

    const to = from + roll;
    if (to > LUDO_HOME) {
      continue;
    }

    const isFinish = to === LUDO_HOME;
    if (isFinish) {
      moves.push({ seat, token, roll, from, to, kind: "finish", captures: [] });
      continue;
    }

    // Inside the home column nothing can be captured: it belongs to this seat.
    if (from >= LUDO_GEOMETRY.ringSteps) {
      moves.push({ seat, token, roll, from, to, kind: "advance", captures: [] });
      continue;
    }

    const cell = ringCellOfToken(seat, to);
    const occupancy = occupancyOf(state, seat, cell);
    if (stacking === "block" && occupancy.opponents >= 2) {
      continue;
    }

    moves.push({
      seat,
      token,
      roll,
      from,
      to,
      kind: "advance",
      captures: capturesAt(state, seat, cell),
    });
  }

  return moves;
}

/** True when this move is one of the seat's legal moves right now. */
export function isLegalMove(state: LudoState, move: LudoMove): boolean {
  return getLegalMoves(state, move.roll).some(
    (candidate) =>
      candidate.token === move.token &&
      candidate.from === move.from &&
      candidate.to === move.to &&
      candidate.seat === move.seat,
  );
}

/** The next seat with tokens left, or the same turn when nobody else can play. */
function advanceTurn(seats: readonly number[], turn: number, state: LudoState): number {
  for (let step = 1; step <= seats.length; step += 1) {
    const candidate = (turn + step) % seats.length;
    const seat = seats[candidate] ?? 0;
    if (!isPlayerFinished(state, seat)) {
      return candidate;
    }
  }
  return turn;
}

/**
 * Records a seat finishing, and ends the game when only one seat is left.
 *
 * The last seat standing is placed without playing on: every token it has left
 * could be brought home eventually, so its place is settled.
 */
function finishSeat(
  tokens: number[],
  state: LudoState,
  seat: number,
  events: LudoEvent[],
  finishing: number[],
): boolean {
  finishing.push(seat);
  events.push({ type: "player_finished", seat, place: finishing.length });

  const { config, seats } = state;
  const unfinished = seats.filter((candidate) => {
    for (let token = 0; token < config.tokensPerPlayer; token += 1) {
      if ((tokens[tokenIndex(config, candidate, token)] ?? LUDO_YARD) !== LUDO_HOME) {
        return true;
      }
    }
    return false;
  });

  if (unfinished.length > 1) {
    return false;
  }

  if (unfinished.length === 1) {
    const last = unfinished[0] ?? 0;
    finishing.push(last);
    events.push({ type: "player_finished", seat: last, place: finishing.length });
  }

  events.push({ type: "game_ended", seat, winner: finishing[0] ?? seat });
  return true;
}

/** A state with the same board, new scalars. */
function withTurn(
  state: LudoState,
  changes: {
    readonly tokens: number[];
    readonly turn: number;
    readonly sixes: number;
    readonly finishingOrder: readonly number[];
    readonly status: "playing" | "finished";
  },
): LudoState {
  return {
    config: state.config,
    seats: state.seats,
    tokens: changes.tokens,
    turn: changes.turn,
    sixes: changes.sixes,
    rolls: state.rolls + 1,
    finishingOrder: changes.finishingOrder,
    status: changes.status,
  };
}

/**
 * Applies one legal move.
 *
 * Throws when the move is not legal, because a caller that reaches this function
 * with an illegal move has a bug: the room validates against `getLegalMoves`
 * first, and the verifier replays moves the referee already accepted.
 */
export function applyMove(state: LudoState, move: LudoMove): LudoOutcome {
  if (state.status === "finished") {
    throw new Error("the game is over");
  }
  if (move.seat !== seatToPlay(state)) {
    throw new Error(`seat ${String(move.seat)} cannot move: it is seat ${String(seatToPlay(state))}'s turn`);
  }
  if (!isLegalMove(state, move)) {
    throw new Error(
      `illegal move: token ${String(move.token)} from ${String(move.from)} to ${String(move.to)} with a ${String(move.roll)}`,
    );
  }

  const { config } = state;
  const tokens = [...state.tokens];
  const events: LudoEvent[] = [];
  const { seat, token, from, to, roll } = move;

  tokens[tokenIndex(config, seat, token)] = to;

  if (from === LUDO_YARD) {
    events.push({ type: "token_out", seat, token, roll, from, to });
  } else if (to === LUDO_HOME) {
    events.push({ type: "token_home", seat, token, roll, from, to });
  } else {
    events.push({ type: "token_moved", seat, token, roll, from, to });
  }

  // Captures were computed when the moves were enumerated; the board has not
  // changed since, so applying them cannot disagree with the enumeration.
  for (const capturedIndex of move.captures) {
    const capturedSeat = Math.floor(capturedIndex / config.tokensPerPlayer);
    const capturedToken = capturedIndex % config.tokensPerPlayer;
    tokens[capturedIndex] = LUDO_YARD;
    events.push({
      type: "capture",
      seat,
      token,
      roll,
      captured: { seat: capturedSeat, token: capturedToken },
    });
  }

  let finishingOrder = state.finishingOrder;
  let status: "playing" | "finished" = state.status;

  if (to === LUDO_HOME && isPlayerFinished({ ...state, tokens }, seat)) {
    const finishing = [...state.finishingOrder];
    const ended = finishSeat(tokens, state, seat, events, finishing);
    finishingOrder = finishing;
    if (ended) {
      status = "finished";
    }
  }

  const sixes = roll === config.diceSides ? state.sixes + 1 : 0;

  if (status === "finished") {
    // The game is over: the six count no longer means anything, and clearing it
    // keeps the state identical to the simulator's at the end of a game.
    return {
      state: withTurn(state, { tokens, turn: state.turn, sixes: 0, finishingOrder, status }),
      events,
    };
  }

  const capturedSomething = move.captures.length > 0;
  const finishedToken = to === LUDO_HOME;
  const earnedExtra =
    (roll === config.diceSides && config.extraRollOnSix) ||
    (capturedSomething && config.extraRollOnCapture) ||
    (finishedToken && config.extraRollOnHome);

  // A player who has just brought the last token home does not roll again: the
  // turn belongs to the next player even if the roll would have earned one.
  const seatFinishedNow = finishingOrder.length > state.finishingOrder.length;
  const turn = seatFinishedNow || !earnedExtra
    ? advanceTurn(state.seats, state.turn, { ...state, tokens })
    : state.turn;

  if (turn === state.turn) {
    events.push({ type: "extra_roll", seat, roll, reason: finishedToken ? "token_home" : capturedSomething ? "capture" : "six" });
  } else {
    events.push({ type: "turn_changed", seat: state.seats[turn] ?? 0 });
  }

  return {
    state: withTurn(state, {
      tokens,
      turn,
      sixes: turn === state.turn ? sixes : 0,
      finishingOrder,
      status,
    }),
    events,
  };
}

/**
 * The turn passes with nothing played: no legal move, or a forfeit.
 *
 * The roll is still counted, because it was drawn from the stream and the verifier
 * must replay the same number of draws.
 */
export function passTurn(state: LudoState, roll: number, reason: string): LudoOutcome {
  const seat = seatToPlay(state);
  const turn = advanceTurn(state.seats, state.turn, state);

  return {
    state: withTurn(state, {
      tokens: [...state.tokens],
      turn,
      sixes: 0,
      finishingOrder: state.finishingOrder,
      status: state.status,
    }),
    events: [
      { type: "no_legal_move", seat, roll, reason },
      { type: "turn_changed", seat: state.seats[turn] ?? 0 },
    ],
  };
}

/** Three sixes in a row: the turn is forfeited and the third 6 is not played. */
export function forfeitTurn(state: LudoState, roll: number, reason: string): LudoOutcome {
  const seat = seatToPlay(state);
  const turn = advanceTurn(state.seats, state.turn, state);

  return {
    state: withTurn(state, {
      tokens: [...state.tokens],
      turn,
      sixes: 0,
      finishingOrder: state.finishingOrder,
      status: state.status,
    }),
    events: [
      { type: "triple_six_forfeit", seat, roll, reason },
      { type: "turn_changed", seat: state.seats[turn] ?? 0 },
    ],
  };
}

/** True when this roll, by this player, is their third six in a row. */
export function shouldForfeitTripleSix(state: LudoState, roll: number): boolean {
  return (
    state.config.tripleSixForfeit &&
    roll === state.config.diceSides &&
    state.sixes === 2
  );
}

/**
 * A whole turn from one roll: forfeit, pass, or the chosen move.
 *
 * This is what the bots and the odds simulator call, and it is the only place the
 * three outcomes of a roll are decided, so the room and the simulator cannot
 * disagree about a rule.
 */
export function applyRoll(state: LudoState, roll: number, choose: LudoChooser): LudoOutcome {
  if (roll < 1 || roll > state.config.diceSides) {
    throw new RangeError(`roll must be 1 to ${String(state.config.diceSides)}, got ${String(roll)}`);
  }
  if (state.status === "finished") {
    throw new Error("the game is over");
  }

  if (shouldForfeitTripleSix(state, roll)) {
    return forfeitTurn(state, roll, "triple_six");
  }

  const moves = getLegalMoves(state, roll);
  if (moves.length === 0) {
    return passTurn(state, roll, "no_legal_move");
  }

  const move = choose(state, roll, moves);
  return applyMove(state, move);
}
