// Informed by reading samiranrl/Carrom_rl (GPL v3) for the rules, board layout
// and shot interface only. This code is original: no line is copied, translated
// or paraphrased from that project. See docs/carrom-rules.md.

import type { UniformRng } from "../../lib/fair-rng.js";
import type { CarromConfig } from "./config.js";

/** A player's colour. White breaks, black answers. */
export type CarromColour = "white" | "black";

/** Colour of a piece on the board: a player's colour, or the queen. */
export type CoinColour = CarromColour | "queen";

/** Why a shot was a foul. */
export type CarromFoulReason = "striker_pocketed" | "opponent_coin_pocketed";

/** Why the queen went back to the centre. */
export type CarromQueenReturnReason = "not_covered" | "no_own_coin" | "foul";

/** Where a shot stands: ready for the next shot, or the match is over. */
export type CarromPhase = "aiming" | "match_ended";

/** A point on the board in millimetres: origin at the centre, x right, y up. */
export interface CarromVec {
  readonly x: number;
  readonly y: number;
}

/** A piece on the board. Ids are stable across a whole match. */
export interface CarromCoin {
  readonly id: string;
  readonly colour: CoinColour;
  readonly x: number;
  readonly y: number;
}

/** Per-player tallies for the current board and the match so far. */
export interface CarromPlayerState {
  /** Points in the match, accumulated across boards. */
  readonly score: number;
  /** Own coins pocketed on this board, 0 to `coinsPerSide`. */
  readonly pocketed: number;
  /** Penalty coins still owed: settled with future pockets. */
  readonly owed: number;
}

/** The queen: where she is, and who still has to cover her. */
export interface CarromQueenState {
  /** True while she is on the board, including after a return to the centre. */
  readonly onBoard: boolean;
  /** Set once someone has covered her for this board. */
  readonly coveredBy: CarromColour | null;
  /** Set when the queen is pocketed but not yet covered: the turn continues. */
  readonly pending: CarromColour | null;
}

/**
 * The whole game, as plain JSON. Small on purpose: a coin is an id, a colour and
 * two numbers, and pocketed coins are absent from `coins`.
 */
export interface CarromState {
  /** State format version, so a stored state can be recognised later. */
  readonly v: 1;
  /** The fair-play seed for this match. */
  readonly seed: string;
  /** Board number within the match, starting at 1. */
  readonly board: number;
  /** Strokes played in the match so far; the shot number carried by events. */
  readonly shot: number;
  /** Whose shot it is. */
  readonly turn: CarromColour;
  readonly phase: CarromPhase;
  readonly queen: CarromQueenState;
  /** Coins still on the board, with their resting positions. */
  readonly coins: readonly CarromCoin[];
  /** Where the striker came to rest, or null if it was pocketed. */
  readonly striker: CarromVec | null;
  readonly players: Readonly<Record<CarromColour, CarromPlayerState>>;
}

/** What a player does: where the striker goes, which way, and how hard. */
export interface CarromShot {
  /** Striker centre on the shooter's baseline, in board millimetres. */
  readonly strikerPosition: CarromVec;
  /** Direction in radians: 0 along +x, increasing anticlockwise. */
  readonly angle: number;
  /** Fraction of `maxShotSpeedMmPerS`, from 0 to 1. */
  readonly power: number;
}

/** One body's position in a recorded frame. */
export interface CarromFrameBody {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** A spectator frame: every body's position at one instant. */
export interface CarromFrame {
  /** Seconds since the shot began. */
  readonly t: number;
  readonly bodies: readonly CarromFrameBody[];
}

/** A spectator recording of one shot, at a fixed frame rate. */
export interface CarromFrames {
  readonly fps: number;
  readonly frames: readonly CarromFrame[];
}

/** Something that happened during a shot. Every event carries the shot number. */
export type CarromEvent =
  | {
      readonly type: "coin_pocketed";
      readonly shot: number;
      /** Colour of the coin that dropped. */
      readonly coin: CarromColour;
      /** Whose pocket it counts for. Differs from `by` after an opponent-coin foul. */
      readonly creditedTo: CarromColour;
      readonly by: CarromColour;
      readonly coinId: string;
    }
  | { readonly type: "queen_pocketed"; readonly shot: number; readonly by: CarromColour }
  | { readonly type: "queen_covered"; readonly shot: number; readonly by: CarromColour }
  | {
      readonly type: "queen_returned";
      readonly shot: number;
      readonly reason: CarromQueenReturnReason;
    }
  | {
      readonly type: "foul";
      readonly shot: number;
      readonly by: CarromColour;
      readonly reason: CarromFoulReason;
    }
  | {
      readonly type: "turn_changed";
      readonly shot: number;
      readonly from: CarromColour;
      readonly to: CarromColour;
    }
  | {
      readonly type: "board_ended";
      readonly shot: number;
      readonly winner: CarromColour;
      readonly points: number;
      /** Opponent coins still on the board, 0 to `coinsPerSide`. */
      readonly opponentCoinsLeft: number;
      /** Points added for a covered queen. */
      readonly queenPoints: number;
    }
  | {
      readonly type: "match_ended";
      readonly shot: number;
      readonly winner: CarromColour | "tie";
      readonly scores: Readonly<Record<CarromColour, number>>;
    };

/** The legal striker zone for the player whose turn it is. */
export interface CarromStrikerRange {
  readonly player: CarromColour;
  /** Which edge of the board the player shoots from. */
  readonly side: "bottom" | "top";
  /** y of the baseline, in board millimetres. */
  readonly y: number;
  readonly minX: number;
  readonly maxX: number;
}

/** Options for one shot. */
export interface CarromShotOptions {
  /** Geometry and match settings. Defaults to {@link DEFAULT_CARROM_CONFIG}. */
  readonly config?: CarromConfig;
  /** Record spectator frames. Off by default: the odds simulator does not need them. */
  readonly recordFrames?: boolean;
  /** Frames per second for the recording. Defaults to the config value. */
  readonly fps?: number;
}

/** The result of a shot. */
export interface CarromShotResult {
  readonly state: CarromState;
  readonly events: readonly CarromEvent[];
  readonly frames: CarromFrames | null;
}

/**
 * A player's measured numbers, as stored in `players.skill` in the database.
 * Bots read whatever keys their policy wants, so this is an open bag of numbers.
 */
export interface BotSkill {
  readonly [name: string]: number;
}

/**
 * A bot: given the state, its own random stream and its skill numbers, chooses a
 * shot. Policies live outside the engine (AI_RULES.md keeps bots out of the
 * rooms) and are not part of the rules implementation.
 */
export interface BotPolicy {
  readonly id: string;
  chooseShot(
    state: CarromState,
    rng: UniformRng,
    skill: BotSkill,
    config?: CarromConfig,
  ): CarromShot;
}
