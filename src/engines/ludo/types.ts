/**
 * Ludo state, moves and events.
 *
 * The state is plain JSON by design: numbers, strings and arrays only, so it can
 * be stored, broadcast and compared without a serialiser. Nothing in it is a
 * class, and no field is ever a reference to something mutable.
 *
 * Informed by reading public Ludo rule sets for the turn order and the idea of a
 * single integer progress per token. This code is original.
 */

import type { LudoConfig } from "./config.js";

/** A token's progress meaning it is home: one past the last home column cell. */
export const LUDO_HOME = 57;

/** A token's progress meaning it is still in its yard. */
export const LUDO_YARD = -1;

/**
 * Everything about a game in progress.
 *
 * `tokens` is flat: `tokens[seat * tokensPerPlayer + token]` is that token's
 * progress. Flat numbers, not objects, because the odds engine plays millions of
 * games and every allocation in the hot path costs.
 */
export interface LudoState {
  /** The rules this game is being played under. */
  readonly config: LudoConfig;
  /** The seats in play, in turn order. */
  readonly seats: readonly number[];
  /** Flat progress per token: `-1` yard, `0..56` on the board, `57` home. */
  readonly tokens: readonly number[];
  /** Index into `seats`, not a seat number. */
  readonly turn: number;
  /** Consecutive sixes by the player whose turn it is. */
  readonly sixes: number;
  /** Die rolls drawn so far, which is the next nonce in the seeded stream. */
  readonly rolls: number;
  /** Seats in the order they brought all their tokens home. */
  readonly finishingOrder: readonly number[];
  readonly status: "playing" | "finished";
}

/** Why a token moved, for the log and for the viewer. */
export type LudoMoveKind = "enter" | "advance" | "finish";

/** One legal move: which token, with which roll, from where to where. */
export interface LudoMove {
  /** The seat making the move. */
  readonly seat: number;
  /** The token's number within its seat, `0` to `tokensPerPlayer - 1`. */
  readonly token: number;
  /** The die value that makes this move legal. */
  readonly roll: number;
  /** Progress before the move. */
  readonly from: number;
  /** Progress after the move. */
  readonly to: number;
  readonly kind: LudoMoveKind;
  /** Flat indices of the tokens this move captures, if any. */
  readonly captures: readonly number[];
}

/** Every event the engine produces. */
export type LudoEventType =
  | "token_out"
  | "token_moved"
  | "capture"
  | "token_home"
  | "extra_roll"
  | "triple_six_forfeit"
  | "no_legal_move"
  | "turn_changed"
  | "player_finished"
  | "game_ended";

/** One thing that happened. Fields are present when they mean something. */
export interface LudoEvent {
  readonly type: LudoEventType;
  /** The seat the event is about. */
  readonly seat: number;
  /** The die value, on a roll-derived event. */
  readonly roll?: number;
  /** The moving token's number within its seat. */
  readonly token?: number;
  /** Progress before the move. */
  readonly from?: number;
  /** Progress after the move. */
  readonly to?: number;
  /** The token this event captured. */
  readonly captured?: { readonly seat: number; readonly token: number };
  /** Place in the finishing order, on `player_finished`. */
  readonly place?: number;
  /** Why the turn was forfeited or passed, where a reason helps. */
  readonly reason?: string;
  /** The winning seat, on `game_ended`. */
  readonly winner?: number;
}

/** What applying a move produced: the next state and what happened. */
export interface LudoOutcome {
  readonly state: LudoState;
  readonly events: readonly LudoEvent[];
}

/** A chooser: given the legal moves, pick one. Bots are these. */
export type LudoChooser = (state: LudoState, roll: number, moves: readonly LudoMove[]) => LudoMove;
