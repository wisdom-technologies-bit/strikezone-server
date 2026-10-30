import { BOT_PROFILES, type BotLevel } from "../engines/carrom/bot-config.js";

/**
 * What we believe about a player's hands.
 *
 * Bots carry published numbers. Humans are measured from their recent finished
 * matches and shrunk towards Club, because ten matches say very little and the
 * quickest way to lose money is to price a stranger as a master after a lucky
 * night.
 */

export interface Skill {
  /** Degrees of standard deviation on the aim. */
  readonly aimErrorDegrees: number;
  /** 0 to 1: how often the shot chosen is the right one. */
  readonly selectionQuality: number;
  /** Chance per shot of a foul. */
  readonly foulRate: number;
  /** How many finished matches the estimate is based on. */
  readonly matches: number;
}

/** Club's numbers, the prior every human starts from. */
export const CLUB_SKILL: Skill = Object.freeze({
  aimErrorDegrees: BOT_PROFILES.club.aimErrorDegrees,
  selectionQuality: BOT_PROFILES.club.selectionQuality,
  foulRate: foulRateFor(BOT_PROFILES.club.aimErrorDegrees, BOT_PROFILES.club.selectionQuality),
  matches: 0,
});

/** Matches needed before a human's own numbers outweigh the prior. */
export const PRIOR_MATCHES = 10;
/** How many recent matches count. */
export const SAMPLE_MATCHES = 30;

/**
 * Fouls per shot, from aim and selection.
 *
 * A player who cannot aim, or who picks the wrong coin, is the one who clips
 * the striker into a pocket. Derived rather than stored so it stays consistent
 * with the published bot numbers, which do not carry a foul rate of their own.
 */
export function foulRateFor(aimErrorDegrees: number, selectionQuality: number): number {
  const aim = Math.min(0.12, Math.max(0, aimErrorDegrees) / 40);
  const selection = Math.max(0, 1 - selectionQuality) * 0.06;
  return Math.min(0.15, 0.012 + aim + selection);
}

/** The published numbers for a bot level. */
export function botSkill(level: BotLevel): Skill {
  const profile = BOT_PROFILES[level];
  return {
    aimErrorDegrees: profile.aimErrorDegrees,
    selectionQuality: profile.selectionQuality,
    foulRate: foulRateFor(profile.aimErrorDegrees, profile.selectionQuality),
    matches: Infinity,
  };
}

/** One finished match, as far as skill is concerned. */
export interface MatchSample {
  readonly aimErrorDegrees: number;
  readonly selectionQuality: number;
  readonly foulRate: number;
}

/** Averages the samples and blends towards Club, weighted by how many there are. */
export function shrinkToPrior(samples: readonly MatchSample[]): Skill {
  if (samples.length === 0) {
    return CLUB_SKILL;
  }

  const mean = (pick: (sample: MatchSample) => number): number =>
    samples.reduce((sum, sample) => sum + pick(sample), 0) / samples.length;

  const weight = Math.min(1, samples.length / PRIOR_MATCHES);

  return {
    aimErrorDegrees:
      CLUB_SKILL.aimErrorDegrees * (1 - weight) + mean((s) => s.aimErrorDegrees) * weight,
    selectionQuality:
      CLUB_SKILL.selectionQuality * (1 - weight) + mean((s) => s.selectionQuality) * weight,
    foulRate: CLUB_SKILL.foulRate * (1 - weight) + mean((s) => s.foulRate) * weight,
    matches: samples.length,
  };
}
