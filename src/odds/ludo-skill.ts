/**
 * Reading a human's play from the choices they made.
 *
 * Ludo has no aiming, so a player's style is entirely in which token they pick:
 * the racer walks the furthest token, the aggressive one takes a capture, the
 * cautious one steps out of danger. This file asks, of every decision a human
 * made, which of the three published policies would have picked the same token,
 * and turns the answers into a weighted mix the simulator can play.
 *
 * Two guards keep an estimate honest:
 *
 * - a choice with one legal move is no evidence at all, so it is dropped;
 * - a thin record is pulled toward an even mix, because a player who has played
 *   three games has not shown a style yet and a market should not pretend they
 *   have.
 *
 * Nothing here is random and nothing here reads the clock.
 */

import {
  aggressiveChooser,
  cautiousChooser,
  getLegalMoves,
  racerChooser,
  type LudoBotId,
  type LudoChooser,
  type LudoState,
} from "../engines/ludo/index.js";
import { EVEN_POLICY_MIX, mixOf, type LudoPolicyMix } from "./ludo-sim.js";

/** How many games before a read is taken at face value. */
export const POLICY_SHRINK_GAMES = 10;

/** How many recent games the read may use. */
export const POLICY_GAME_WINDOW = 30;

/** One decision a player made: the position, the roll, and the token they moved. */
export interface LudoMoveChoice {
  /** The board before the roll was played. */
  readonly state: LudoState;
  readonly roll: number;
  /** Which of the player's tokens they moved. */
  readonly token: number;
}

/** A player's decisions over their recent games. */
export interface LudoPolicyObservation {
  readonly choices: readonly LudoMoveChoice[];
  /** How many games those decisions came from. */
  readonly games: number;
}

/** How one decision reads: which policies would have moved the same token. */
export interface LudoChoiceRead {
  readonly token: number;
  readonly matches: Readonly<Record<LudoBotId, boolean>>;
}

const CHOOSERS: readonly (readonly [LudoBotId, LudoChooser])[] = Object.freeze([
  ["cautious", cautiousChooser] as const,
  ["aggressive", aggressiveChooser] as const,
  ["racer", racerChooser] as const,
]);

/** Reads one decision against the three policies. */
export function readChoice(choice: LudoMoveChoice): LudoChoiceRead | null {
  const moves = getLegalMoves(choice.state, choice.roll);
  // One legal move is not a decision: every policy plays it, so it is no evidence.
  if (moves.length < 2) {
    return null;
  }
  if (!moves.some((move) => move.token === choice.token)) {
    // Not a legal move for this position: the record is wrong, not the player.
    return null;
  }

  const matches = {} as Record<LudoBotId, boolean>;
  for (const [id, choose] of CHOOSERS) {
    const picked = choose(choice.state, choice.roll, moves);
    matches[id] = picked.token === choice.token;
  }
  return { token: choice.token, matches };
}

/** The share of decisions each policy accounts for, before any shrinking. */
export function observedShares(observation: LudoPolicyObservation): {
  readonly mix: LudoPolicyMix;
  readonly informative: number;
} {
  const counts: Record<LudoBotId, number> = { cautious: 0, aggressive: 0, racer: 0 };
  let informative = 0;

  for (const choice of observation.choices) {
    const read = readChoice(choice);
    if (read === null) {
      continue;
    }
    informative += 1;
    for (const [id] of CHOOSERS) {
      if (read.matches[id]) {
        counts[id] += 1;
      }
    }
  }

  if (informative === 0) {
    return { mix: EVEN_POLICY_MIX, informative: 0 };
  }

  const total = counts.cautious + counts.aggressive + counts.racer;
  if (total === 0) {
    // The player moved in a way none of the three would: no style to read yet.
    return { mix: EVEN_POLICY_MIX, informative };
  }

  return {
    mix: {
      cautious: counts.cautious / total,
      aggressive: counts.aggressive / total,
      racer: counts.racer / total,
    },
    informative,
  };
}

/**
 * A player's policy mix, shrunk toward even play.
 *
 * `games` decides how much of the read is believed: at ten games the estimate is
 * used as measured, below that it is blended into an even mix in proportion to
 * how much of the record exists.
 */
export function estimatePolicyMix(
  observation: LudoPolicyObservation,
  options: { readonly shrinkGames?: number } = {},
): LudoPolicyMix {
  const shrinkGames = options.shrinkGames ?? POLICY_SHRINK_GAMES;
  const { mix } = observedShares(observation);
  const weight = Math.max(0, Math.min(1, observation.games / shrinkGames));

  if (weight >= 1) {
    return mix;
  }

  const blend = (observed: number, even: number): number => observed * weight + even * (1 - weight);
  const blended: LudoPolicyMix = {
    cautious: blend(mix.cautious, EVEN_POLICY_MIX.cautious),
    aggressive: blend(mix.aggressive, EVEN_POLICY_MIX.aggressive),
    racer: blend(mix.racer, EVEN_POLICY_MIX.racer),
  };

  return normaliseMix(blended);
}

/** Weights that sum to one, with any negative weight dropped. */
export function normaliseMix(mix: LudoPolicyMix): LudoPolicyMix {
  const cautious = Math.max(0, mix.cautious);
  const aggressive = Math.max(0, mix.aggressive);
  const racer = Math.max(0, mix.racer);
  const total = cautious + aggressive + racer;
  if (total <= 0) {
    return EVEN_POLICY_MIX;
  }
  return { cautious: cautious / total, aggressive: aggressive / total, racer: racer / total };
}

/**
 * The policy a seat plays, from what is known about them.
 *
 * A bot plays the policy it is configured with; a human plays the mix read from
 * their recent games, or an even mix when there is no record at all.
 */
export function policyForSeat(seat: {
  readonly isBot: boolean;
  readonly botPolicy: string | null;
  readonly observation?: LudoPolicyObservation;
}): LudoBotId | LudoPolicyMix {
  if (seat.isBot) {
    const policy = seat.botPolicy;
    if (policy === "cautious" || policy === "aggressive" || policy === "racer") {
      return policy;
    }
    return "cautious";
  }
  return seat.observation === undefined ? EVEN_POLICY_MIX : estimatePolicyMix(seat.observation);
}

/** The mix a policy plays, which for a fixed bot is all of one and none of the rest. */
export function mixForPolicy(policy: LudoBotId | LudoPolicyMix): LudoPolicyMix {
  return mixOf(policy);
}
