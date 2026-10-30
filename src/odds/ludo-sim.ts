/**
 * Playing Ludo for the odds engine.
 *
 * Ludo has no physics to approximate, so a price here is the frequency of an
 * outcome over games played by the rules themselves. `LudoSimulator` plays them
 * (the same game as `rules.ts`, proven by the parity test), this file drives it:
 * it draws the rolls and the policy for each turn from one uniform stream, folds
 * every turn into a {@link LudoStatsBuilder}, and hands back the facts the market
 * catalogue settles against.
 *
 * Three things make a million games affordable:
 *
 * - one simulator per batch, reset between games, so nothing allocates per game
 *   except the stats the caller asked for;
 * - home counts folded incrementally instead of scanned every turn;
 * - the same builder the settlement path uses, so a simulated game and a played
 *   one describe themselves identically.
 *
 * The pool runs the same function on worker threads. Splitting by seed rather
 * than by game keeps every game reproducible on its own: game `i` of a batch is
 * always the game seed `seed:i` describes, whichever worker played it.
 */

import { availableParallelism } from "node:os";
import {
  LUDO_HOME,
  resolveLudoConfig,
  seatsOf,
  type LudoConfig,
  type LudoBotId,
  type LudoState,
} from "../engines/ludo/index.js";
import { LudoSimulator } from "../engines/ludo/sim.js";
import { LudoStatsBuilder, LUDO_TURN_CAP, type LudoGameStats } from "./ludo-stats.js";

/** A weighted mix of the three published bot policies. */
export interface LudoPolicyMix {
  readonly cautious: number;
  readonly aggressive: number;
  readonly racer: number;
}

/** The three policy ids, in the order a mixture is sampled in. */
export const LUDO_POLICIES: readonly LudoBotId[] = Object.freeze([
  "cautious",
  "aggressive",
  "racer",
]);

/** A seat plays one fixed policy, or a mixture of the three. */
export type LudoSeatPolicy = LudoBotId | LudoPolicyMix;

/** An even mixture, the starting point for a human nobody has watched yet. */
export const EVEN_POLICY_MIX: LudoPolicyMix = Object.freeze({
  cautious: 1 / 3,
  aggressive: 1 / 3,
  racer: 1 / 3,
});

/** A policy that is the same everywhere, which is what a bot table is. */
export function mixOf(policy: LudoSeatPolicy): LudoPolicyMix {
  if (typeof policy !== "string") {
    return policy;
  }
  return {
    cautious: policy === "cautious" ? 1 : 0,
    aggressive: policy === "aggressive" ? 1 : 0,
    racer: policy === "racer" ? 1 : 0,
  };
}

/**
 * Picks the policy for one decision, from a draw in `[0, 1)`.
 *
 * A mixture is played, not averaged: a human who chooses like the aggressive bot
 * two times in five chooses like it on those turns, and the fallback order keeps
 * the pick stable when the weights do not sum to exactly one.
 */
export function samplePolicy(mix: LudoPolicyMix, draw: number): LudoBotId {
  const cautious = Math.max(0, mix.cautious);
  const aggressive = Math.max(0, mix.aggressive);
  const total = cautious + aggressive + Math.max(0, mix.racer);
  if (total <= 0) {
    return "cautious";
  }
  const point = draw * total;
  if (point < cautious) {
    return "cautious";
  }
  if (point < cautious + aggressive) {
    return "aggressive";
  }
  return "racer";
}

/** A uniform stream: `[0, 1)`, called three or so times per turn. */
export type LudoRandom = () => number;

/** What one simulated game needs to know. */
export interface LudoGameOptions {
  readonly config?: Partial<LudoConfig>;
  /** The policy of each seat in play, by seat number. Missing seats are cautious. */
  readonly policies?: Readonly<Record<number, LudoSeatPolicy>>;
  /** The uniform stream. Never `Math.random` (AI_RULES.md). */
  readonly random: LudoRandom;
  /** Play from this position instead of the yard, for a live reprice. */
  readonly from?: LudoState;
  /** Keep the per-turn token trace. Off by default: a million traces is gigabytes. */
  readonly trace?: boolean;
  /** Turns before the game is called abandoned. Defaults to {@link LUDO_TURN_CAP}. */
  readonly turnCap?: number;
}

/** What a driver needs to keep between games so a batch allocates nothing. */
export interface LudoGameRunner {
  /** Plays one game from the yard. */
  play(options: Omit<LudoGameOptions, "config"> & { readonly random: LudoRandom }): LudoGameStats;
  /** Plays one game from an arbitrary position. */
  resume(
    state: LudoState,
    options: Omit<LudoGameOptions, "config" | "from"> & { readonly random: LudoRandom },
  ): LudoGameStats;
}

/**
 * Plays games one after another with one simulator, for a batch.
 *
 * The policies are per seat and fixed for the runner's life, which is what a
 * batch wants: the same four players, a million times.
 */
export function createLudoGameRunner(options: {
  readonly config?: Partial<LudoConfig>;
  readonly policies?: Readonly<Record<number, LudoSeatPolicy>>;
}): LudoGameRunner {
  const config = resolveLudoConfig(options.config);
  const seats = seatsOf(config);
  // Indexed by seat number, not by turn order: seat 2 of a two player game is the
  // second seat to play but the third entry of this array.
  const policyBySeat: LudoSeatPolicy[] = ["cautious", "cautious", "cautious", "cautious"];
  for (const seat of seats) {
    policyBySeat[seat] = options.policies?.[seat] ?? "cautious";
  }
  const simulator = new LudoSimulator({ config, policy: "cautious" });

  const playFrom = (
    start: LudoState | null,
    random: LudoRandom,
    trace: boolean,
    turnCap: number,
  ): LudoGameStats => {
    if (start === null) {
      simulator.reset();
    } else {
      simulator.loadState(start);
    }

    const builder = new LudoStatsBuilder({ seats, trace });
    // Tokens home are folded forward instead of rescanned: only a token reaching
    // home changes this count, and a capture sends a token to the yard, never home.
    const home: number[] = [0, 0, 0, 0];
    for (const seat of seats) {
      home[seat] = start === null ? 0 : simulator.homeCountOf(seat);
    }

    let lastRoll: number | null = null;
    let turns = 0;

    while (simulator.status === "playing" && turns < turnCap) {
      const seat = simulator.seatToPlay;
      const roll = Math.floor(random() * config.diceSides) + 1;
      const policy = samplePolicy(mixOf(policyBySeat[seat] ?? "cautious"), random());
      const result = simulator.playTurn(roll, policy);
      lastRoll = roll;
      turns += 1;

      if (result.broughtHome) {
        home[seat] = (home[seat] ?? 0) + 1;
      }

      const captures: { seat: number; victim: number }[] = [];
      for (const victim of seats) {
        if ((result.capturedSeatMask & (1 << victim)) !== 0) {
          captures.push({ seat, victim });
        }
      }

      builder.turn({
        seat,
        roll,
        captures,
        broughtHome: result.broughtHome,
        firstOut: result.entered,
        forfeitedTripleSix: result.forfeited,
        finishedSeat: home[seat] === config.tokensPerPlayer,
        homeAfter: [...home],
      });
    }

    const abandoned = simulator.status !== "finished";
    const order = simulator.finishingOrder();
    const winnerSeat = abandoned ? null : (order[0] ?? null);

    // The simulator owns the finishing order: a game resumed mid-way starts with
    // seats already home, and the builder never saw them finish.
    return builder.stats({ winnerSeat, lastRoll, abandoned, finishingOrder: [...order] });
  };

  return {
    play: (playOptions) =>
      playFrom(
        null,
        playOptions.random,
        playOptions.trace === true,
        playOptions.turnCap ?? LUDO_TURN_CAP,
      ),
    resume: (state, resumeOptions) =>
      playFrom(
        state,
        resumeOptions.random,
        resumeOptions.trace === true,
        resumeOptions.turnCap ?? LUDO_TURN_CAP,
      ),
  };
}

/** Plays one game, allocating a runner for it. For tests and single calls. */
export function simulateLudoGame(options: LudoGameOptions): LudoGameStats {
  const runner = createLudoGameRunner({ config: options.config, policies: options.policies });
  const playOptions = { random: options.random, trace: options.trace, turnCap: options.turnCap };
  return options.from === undefined
    ? runner.play(playOptions)
    : runner.resume(options.from, playOptions);
}

/**
 * A seeded uniform stream, reproducible from the seed string alone.
 *
 * mulberry32, seeded by FNV-1a over the string: a 32-bit generator with a long
 * period and no visible bias in the high bits, which is what a frequency count
 * needs. Thirty-two bit arithmetic only, so it is the same stream in a worker and
 * on the main thread, and the same stream on any machine.
 */
export function seededUniform(seed: string): LudoRandom {
  let seedState = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    seedState ^= seed.charCodeAt(index);
    seedState = Math.imul(seedState, 0x01000193) >>> 0;
  }

  let state = seedState >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** The tokens home a seat has in a position, for a resume. */
export function homeInPosition(state: LudoState, seat: number): number {
  const { tokensPerPlayer } = state.config;
  let home = 0;
  for (let token = 0; token < tokensPerPlayer; token += 1) {
    if ((state.tokens[seat * tokensPerPlayer + token] ?? -1) === LUDO_HOME) {
      home += 1;
    }
  }
  return home;
}

/**
 * How many worker threads a price should use: every core the process may run on,
 * at most eight.
 *
 * This is a default, not a promise: the pricer's calibration run decides how many
 * games fit the budget, and a machine that turns out slower than its core count
 * suggests still finishes inside the deadline by playing fewer games.
 */
export function defaultThreads(): number {
  const cores = availableParallelism();
  return Math.max(1, Math.min(8, cores));
}
