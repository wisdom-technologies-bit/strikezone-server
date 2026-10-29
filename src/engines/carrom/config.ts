/**
 * Carrom geometry, physics and match settings.
 *
 * Every tunable number lives here: sizes in millimetres, masses in grams, times
 * in seconds, speeds in millimetres per second. Override pieces of it with
 * {@link resolveConfig} rather than editing this file, and keep the defaults in
 * the range where a 740 mm board plays like a real one.
 */

// Informed by reading samiranrl/Carrom_rl (GPL v3) for the rules, board layout
// and shot interface only. This code is original: no line is copied, translated
// or paraphrased from that project. See docs/carrom-rules.md.

export interface CarromConfig {
  /** Side length of the square playing area. */
  readonly boardSizeMm: number;
  /** Diameter of a corner pocket. */
  readonly pocketDiameterMm: number;
  /** Distance from each adjoining wall to a pocket centre. */
  readonly pocketInsetMm: number;
  readonly coinDiameterMm: number;
  readonly strikerDiameterMm: number;
  readonly coinMassG: number;
  readonly strikerMassG: number;
  /** Restitution against a wall. */
  readonly wallRestitution: number;
  /** Restitution for coin to coin and striker to coin contacts. */
  readonly coinRestitution: number;
  /** Constant deceleration applied to every moving body. */
  readonly rollingFrictionMmPerS2: number;
  /** A body slower than this stops exactly. */
  readonly stopSpeedMmPerS: number;
  /** Speed of the striker at power 1. */
  readonly maxShotSpeedMmPerS: number;
  /** Fixed simulation timestep: 1/240 s. */
  readonly stepSeconds: number;
  /** A shot is force-stopped after this long, discarding leftover motion. */
  readonly maxShotSeconds: number;
  /** Distance from the shooter's wall to the centre of their baseline. */
  readonly baselineOffsetMm: number;
  /** How far the legal striker zone is inset from each side wall. */
  readonly baselineEndInsetMm: number;
  /** Frame rate for the spectator recording. */
  readonly framesPerSecond: number;
  /** Pair-resolution passes per step, so clusters of coins settle in one step. */
  readonly collisionIterations: number;
  /** Coins of one colour on the board. */
  readonly coinsPerSide: number;
  /** Points for a covered queen. */
  readonly queenPoints: number;
  /** Match ends when a player reaches this score. */
  readonly pointsToWinMatch: number;
  /** Match ends after this many boards regardless of score. */
  readonly boardsPerMatch: number;
  /** Minimum gap between the striker and a coin when it is placed. */
  readonly strikerClearanceMm: number;
  /** Slack allowed when checking that bodies do not overlap. */
  readonly overlapToleranceMm: number;
}

/**
 * Defaults for a 740 mm board with 31 mm coins, a 41 mm striker and 45 mm
 * pockets. Friction and shot speed are tuned so a full-power flick would travel
 * about four board widths on a clear board and settles within two seconds.
 */
export const DEFAULT_CARROM_CONFIG: CarromConfig = Object.freeze({
  boardSizeMm: 740,
  pocketDiameterMm: 45,
  pocketInsetMm: 45,
  coinDiameterMm: 31,
  strikerDiameterMm: 41,
  coinMassG: 5,
  strikerMassG: 15,
  wallRestitution: 0.6,
  coinRestitution: 0.9,
  rollingFrictionMmPerS2: 1600,
  stopSpeedMmPerS: 8,
  maxShotSpeedMmPerS: 3200,
  stepSeconds: 1 / 240,
  maxShotSeconds: 3,
  baselineOffsetMm: 90,
  baselineEndInsetMm: 120,
  framesPerSecond: 30,
  collisionIterations: 2,
  coinsPerSide: 9,
  queenPoints: 3,
  pointsToWinMatch: 25,
  boardsPerMatch: 8,
  strikerClearanceMm: 0,
  overlapToleranceMm: 0.01,
});

/** Fields that must be strictly positive. */
const POSITIVE_FIELDS = [
  "boardSizeMm",
  "pocketDiameterMm",
  "pocketInsetMm",
  "coinDiameterMm",
  "strikerDiameterMm",
  "coinMassG",
  "strikerMassG",
  "rollingFrictionMmPerS2",
  "stopSpeedMmPerS",
  "maxShotSpeedMmPerS",
  "stepSeconds",
  "maxShotSeconds",
  "framesPerSecond",
  "collisionIterations",
  "coinsPerSide",
  "boardsPerMatch",
] as const satisfies readonly (keyof CarromConfig)[];

/** Fields that must stay inside [0, 1). */
const RESTITUTION_FIELDS = [
  "wallRestitution",
  "coinRestitution",
] as const satisfies readonly (keyof CarromConfig)[];

/** Fields that must be zero or more. */
const NON_NEGATIVE_FIELDS = [
  "baselineOffsetMm",
  "baselineEndInsetMm",
  "queenPoints",
  "pointsToWinMatch",
  "strikerClearanceMm",
  "overlapToleranceMm",
] as const satisfies readonly (keyof CarromConfig)[];

/**
 * Applies overrides to the defaults and rejects values that cannot work, such as
 * a zero-diameter coin or a restitution of 1 (which never loses energy).
 */
export function resolveConfig(overrides: Partial<CarromConfig> = {}): CarromConfig {
  const merged: CarromConfig = { ...DEFAULT_CARROM_CONFIG, ...overrides };

  for (const field of POSITIVE_FIELDS) {
    if (!Number.isFinite(merged[field]) || merged[field] <= 0) {
      throw new RangeError(`carrom config: ${field} must be a positive number`);
    }
  }
  for (const field of RESTITUTION_FIELDS) {
    if (!Number.isFinite(merged[field]) || merged[field] < 0 || merged[field] >= 1) {
      throw new RangeError(`carrom config: ${field} must be in [0, 1)`);
    }
  }
  for (const field of NON_NEGATIVE_FIELDS) {
    if (!Number.isFinite(merged[field]) || merged[field] < 0) {
      throw new RangeError(`carrom config: ${field} must be zero or more`);
    }
  }
  if (merged.boardsPerMatch < 1 || !Number.isInteger(merged.boardsPerMatch)) {
    throw new RangeError("carrom config: boardsPerMatch must be a whole number of at least 1");
  }
  if (!Number.isInteger(merged.coinsPerSide)) {
    throw new RangeError("carrom config: coinsPerSide must be a whole number");
  }
  if (merged.baselineEndInsetMm * 2 >= merged.boardSizeMm) {
    throw new RangeError("carrom config: baselineEndInsetMm leaves no legal striker zone");
  }
  if (merged.baselineOffsetMm >= merged.boardSizeMm / 2) {
    throw new RangeError("carrom config: baselineOffsetMm puts the baseline outside the board");
  }
  if (merged.coinDiameterMm >= merged.boardSizeMm) {
    throw new RangeError("carrom config: the coin does not fit on the board");
  }

  return Object.freeze(merged);
}
