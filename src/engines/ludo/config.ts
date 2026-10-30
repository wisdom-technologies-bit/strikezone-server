/**
 * Ludo geometry, dice and match settings.
 *
 * Every tunable number and rule switch lives here, so a match can be played under
 * a different rule set without touching the engine. The defaults are the ones
 * written down in docs/ludo-rules.md.
 *
 * Informed by reading the rules descriptions of public Ludo rule sets and open
 * source Ludo games for the board topology and turn order only. This code is
 * original: no line is copied, translated or paraphrased from them.
 */

/** One cell of the outer ring. */
export interface LudoGeometry {
  /** Cells in the outer ring. */
  readonly ringCells: number;
  /** Ring progress of the last ring cell: 51 steps after leaving the yard. */
  readonly ringSteps: number;
  /** Cells in one home column. */
  readonly homeCells: number;
  /** Progress that means home, one past the last home cell. */
  readonly homeProgress: number;
  /** The starting cell of each seat, by seat index. */
  readonly startCells: readonly number[];
  /** Ring cells no token can be captured on. */
  readonly safeCells: readonly number[];
  /** Progress of a token that has not left the yard. */
  readonly yardProgress: number;
}

export interface LudoConfig {
  /** How many players take part: 2 (opposite seats) or 4. */
  readonly players: 2 | 4;
  /** Tokens each player brings home to finish. */
  readonly tokensPerPlayer: number;
  /** Faces on the die. Only 6 is supported by the extra-roll and yard rules. */
  readonly diceSides: number;
  /** A 6 grants another roll to the same player. */
  readonly extraRollOnSix: boolean;
  /** Three sixes in a row forfeit the turn, and the third 6 is not played. */
  readonly tripleSixForfeit: boolean;
  /** A capture grants another roll. */
  readonly extraRollOnCapture: boolean;
  /** Finishing a token grants another roll. */
  readonly extraRollOnHome: boolean;
  /**
   * How many tokens of one colour may share a cell.
   * "block" makes a cell with two or more of one colour impossible for an
   * opponent to land on; "open" allows it and captures every one of them.
   */
  readonly stacking: "block" | "open";
  /** Turns after this many timeouts forfeit the whole match. */
  readonly timeoutsToForfeit: number;
  /** Seconds a player has to choose a move. */
  readonly moveSeconds: number;
}

/** The board, fixed. Not part of the configurable rule set: the geometry is Ludo. */
export const LUDO_GEOMETRY: LudoGeometry = Object.freeze({
  ringCells: 52,
  ringSteps: 51,
  homeCells: 6,
  homeProgress: 57,
  startCells: Object.freeze([0, 13, 26, 39]) as readonly number[],
  safeCells: Object.freeze([0, 8, 13, 21, 26, 34, 39, 47]) as readonly number[],
  yardProgress: -1,
});

/** The defaults, as written in docs/ludo-rules.md. */
export const DEFAULT_LUDO_CONFIG: LudoConfig = Object.freeze({
  players: 4,
  tokensPerPlayer: 4,
  diceSides: 6,
  extraRollOnSix: true,
  tripleSixForfeit: true,
  extraRollOnCapture: true,
  extraRollOnHome: true,
  stacking: "block",
  timeoutsToForfeit: 3,
  moveSeconds: 20,
});

/** Only a six-sided die is supported: the rules above are written for one. */
const SUPPORTED_SIDES = 6;

/** Checks a config, and fills in the defaults for anything left out. */
export function resolveLudoConfig(partial: Partial<LudoConfig> = {}): LudoConfig {
  const config: LudoConfig = { ...DEFAULT_LUDO_CONFIG, ...partial };

  if (config.players !== 2 && config.players !== 4) {
    throw new RangeError(`players must be 2 or 4, got ${String(config.players)}`);
  }
  if (config.diceSides !== SUPPORTED_SIDES) {
    throw new RangeError(`only a ${String(SUPPORTED_SIDES)}-sided die is supported`);
  }
  if (!Number.isInteger(config.tokensPerPlayer) || config.tokensPerPlayer < 1) {
    throw new RangeError(`tokensPerPlayer must be a whole number of at least 1`);
  }
  if (!Number.isInteger(config.moveSeconds) || config.moveSeconds < 1) {
    throw new RangeError("moveSeconds must be a whole number of at least 1");
  }
  if (!Number.isInteger(config.timeoutsToForfeit) || config.timeoutsToForfeit < 1) {
    throw new RangeError("timeoutsToForfeit must be a whole number of at least 1");
  }

  return Object.freeze(config);
}

/**
 * The seats in play, in turn order.
 *
 * Two players sit opposite each other, so a two player match uses seats 0 and 2
 * and their starting cells are 26 cells apart.
 */
export function seatsOf(config: LudoConfig): readonly number[] {
  const seats: number[] = [];
  for (let seat = 0; seat < config.players; seat += 1) {
    seats.push(config.players === 2 ? seat * 2 : seat);
  }
  return seats;
}

/** The starting cell of one seat. */
export function startCellOf(seat: number): number {
  return LUDO_GEOMETRY.startCells[seat] ?? 0;
}

/** True when a ring cell is safe for everyone. */
export function isSafeCell(cell: number): boolean {
  return LUDO_GEOMETRY.safeCells.includes(cell);
}

/**
 * The ring cell a token is standing on, or null when it is in the yard, in its
 * home column, or home.
 */
export function ringCellOf(seat: number, progress: number): number | null {
  if (progress < 0 || progress > LUDO_GEOMETRY.ringSteps - 1) {
    return null;
  }
  return (startCellOf(seat) + progress) % LUDO_GEOMETRY.ringCells;
}
