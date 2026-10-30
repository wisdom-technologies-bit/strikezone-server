import { env } from "../lib/env.js";

/**
 * The odds engine's knobs: how much can be staked on a market, how many matches
 * a price is built from, and the bounds a price may never leave.
 */

/** Simulations behind a pre-match price. */
export const PRICE_SIMULATIONS = 100_000;
/** Simulations behind a live reprice, which has a second to work in. */
export const LIVE_SIMULATIONS = 5_000;

/** No selection is ever priced longer than this, whatever the model says. */
export const MIN_PROBABILITY = 0.015;
/** And no price is shorter than 1.01 or longer than 1000. */
export const MIN_ODDS = 1.01;
export const MAX_ODDS = 1_000;

/** House margin, from the environment, as basis points. */
export function houseMarginBps(): number {
  return env.HOUSE_MARGIN_BPS;
}

/**
 * Stake ceilings in minor units, by how much a market matters.
 *
 * A niche market on the number of shots in board one cannot carry the same
 * liability as the match winner, so it is capped lower.
 */
export const MAX_STAKE_BY_TIER = {
  main: 500_000,
  standard: 200_000,
  niche: 50_000,
} as const;

/** How long a market is suspended after a shot, in milliseconds. */
export const SUSPENSION_MS = 2_000;

/** A live match is repriced at most this often, in milliseconds. */
export const REPRICE_INTERVAL_MS = 1_000;

/**
 * Odds for a fair probability: the margin is applied to the probability, then
 * converted, floored to two decimals and clamped to the allowed band.
 */
export function oddsFor(fairProbability: number, marginBps = houseMarginBps()): number {
  const probability = Math.max(MIN_PROBABILITY, Math.min(0.999, fairProbability));
  const raw = 100 / (probability * (1 + marginBps / 10_000));
  const floored = Math.floor(raw) / 100;
  return Math.min(MAX_ODDS, Math.max(MIN_ODDS, Number(floored.toFixed(2))));
}
