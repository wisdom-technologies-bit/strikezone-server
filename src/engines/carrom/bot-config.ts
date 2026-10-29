// Bot levels and every number that shapes their play. Pure data: no imports from
// anything but carrom types, so a bot can never reach betting or odds data
// (AI_RULES.md hard rule 4).
//
// `aimErrorDegrees` is the standard deviation of the angle error added to the
// chosen shot, `selectionQuality` drives the softmax over candidate shots (1 would
// always take the best candidate), and `powerErrorFraction` is the relative
// standard deviation of the power.

/** The published bot levels. */
export const BOT_LEVELS = ["rookie", "club", "master"] as const;

/** A published bot level. */
export type BotLevel = (typeof BOT_LEVELS)[number];

/** One bot level's numbers, as published by GET /api/bots. */
export interface BotProfile {
  readonly level: BotLevel;
  /** Stored in players.bot_policy. */
  readonly policy: string;
  /** Shown everywhere, never mistakable for a human name. */
  readonly displayName: string;
  readonly aimErrorDegrees: number;
  readonly selectionQuality: number;
  readonly powerErrorFraction: number;
}

/**
 * The three levels. Rookie, Club and Master differ only in these numbers, so
 * tuning difficulty means editing this table.
 */
export const BOT_PROFILES: Readonly<Record<BotLevel, BotProfile>> = Object.freeze({
  rookie: {
    level: "rookie",
    policy: "carrom_rookie",
    displayName: "Bot Rookie",
    aimErrorDegrees: 4,
    selectionQuality: 0.4,
    powerErrorFraction: 0.14,
  },
  club: {
    level: "club",
    policy: "carrom_club",
    displayName: "Bot Club",
    aimErrorDegrees: 2,
    selectionQuality: 0.7,
    powerErrorFraction: 0.09,
  },
  master: {
    level: "master",
    policy: "carrom_master",
    displayName: "Bot Master",
    aimErrorDegrees: 0.8,
    selectionQuality: 0.95,
    powerErrorFraction: 0.05,
  },
});

/** Shape of the shot search, shared by every level. */
export const BOT_TUNING = Object.freeze({
  /** Softmax temperature at quality 0: lower temperature means a sharper choice. */
  softmaxTemperatureScale: 0.35,
  /** Never divide by a temperature below this. */
  softmaxTemperatureFloor: 0.005,
  /** A cut worse than this angle is effectively hopeless, and scores near zero. */
  cutAngleScaleDegrees: 35,
  /** Path length at which the distance penalty costs a factor of two. */
  distanceScaleMm: 900,
  /** Score penalty per coin sitting on the shot's path. */
  blockerPenalty: 1.1,
  /** However crowded the board, a blocked shot is not scored below this. */
  maxBlockerPenalty: 6,
  /** Score penalty for a shot that only works with the striker clamped to the baseline end. */
  clampedPenalty: 1.5,
  /** How much further the striker must travel than the coin, to cover contact loss. */
  strikerTravelFactor: 1.5,
  /** And how much further the coin must be able to travel than its pocket distance. */
  coinTravelFactor: 1.3,
  /**
   * Full-power travel on a clear board: its speed is `maxShotSpeedMmPerS`, and it
   * decelerates at `rollingFrictionMmPerS2`, so it covers speed² / (2 · friction).
   * Used to turn a path length into a power, not guessed.
   */
  fullPowerTravelMm: 3_200,
  minPower: 0.2,
  maxPower: 0.98,
  /** Samples taken along each leg of a candidate path when checking for blockers. */
  pathSamples: 24,
  /**
   * Approach shots score a fraction of a real pot. They exist so a bot with no
   * potting line still hits something instead of nudging the striker up the board
   * forever: a coin near a wall behind the baseline can be genuinely unreachable in
   * a straight line.
   */
  approachDiscount: 0.3,
});

/** The skill numbers a bot reads. They match the columns of players.skill. */
export interface BotSkillNumbers {
  readonly aimErrorDegrees: number;
  readonly selectionQuality: number;
  readonly powerErrorFraction: number;
}

/** The skill bag for a level, optionally overridden by a stored players.skill row. */
export function botSkillNumbers(
  level: BotLevel,
  overrides: Readonly<Record<string, number>> = {},
): BotSkillNumbers {
  const profile = BOT_PROFILES[level];

  const pick = (key: keyof BotSkillNumbers, fallback: number): number => {
    const value = overrides[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };

  return {
    aimErrorDegrees: Math.max(0, pick("aimErrorDegrees", profile.aimErrorDegrees)),
    selectionQuality: Math.min(1, Math.max(0, pick("selectionQuality", profile.selectionQuality))),
    powerErrorFraction: Math.max(0, pick("powerErrorFraction", profile.powerErrorFraction)),
  };
}

/** True when a string names a published bot level. */
export function isBotLevel(value: string): value is BotLevel {
  return (BOT_LEVELS as readonly string[]).includes(value);
}
