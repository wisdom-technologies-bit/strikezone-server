/**
 * Dice for Ludo, drawn from the seeded generator.
 *
 * Two sources, both anchored in the match seed:
 *
 * - {@link createMatchDice} is authoritative. Every roll is one draw from
 *   `rngAt(seed, matchId, nonce)` with the nonce incrementing by one, so a whole
 *   game can be recomputed from the revealed seed and the match id. The room and
 *   the verifier use this one.
 * - {@link createFastDice} is the accelerator for the odds engine and the
 *   benchmark. One HMAC draws a 48-byte-anchored block that is expanded through
 *   xoshiro128**, 4096 rolls at a time. It is still seed-anchored and still
 *   deterministic, but it is a different stream from the authoritative one, so it
 *   is never used where a recorded game has to replay.
 *
 * Informed by reading public descriptions of counter-based generators. This code
 * is original.
 */

import { rngAt } from "../../lib/fair-rng.js";

/** A source of die faces. */
export interface DieSource {
  /** The next face, from 1 to `sides`. */
  roll(sides: number): number;
  /** How many rolls this source has produced. */
  readonly rolls: number;
}

/** Rolls per HMAC block in the fast source. */
const FAST_BLOCK_ROLLS = 4096;

/**
 * The authoritative source: one uniform per roll, from the match's own stream.
 *
 * `startNonce` exists so a game can be resumed after a restart without replaying
 * the stream it already consumed.
 */
export function createMatchDice(seed: string, matchId: string, startNonce = 0): DieSource {
  let nonce = startNonce;
  let rolls = 0;

  return {
    get rolls(): number {
      return rolls;
    },
    roll(sides: number): number {
      const uniform = rngAt(seed, matchId, nonce);
      nonce += 1;
      rolls += 1;
      return 1 + Math.floor(uniform * sides);
    },
  };
}

/**
 * xoshiro128** over four 32-bit words, seeded from the match stream.
 *
 * Chosen over a cryptographic draw per roll because the odds engine needs a
 * million turns a second; chosen over a plain LCG because the die has to be
 * uniform enough to pass a chi-square test over a million rolls, and an LCG's low
 * bits are not.
 */
interface Xoshiro {
  read(): number;
}

function xoshiro128(seedWords: readonly [number, number, number, number]): Xoshiro {
  let a = seedWords[0] | 0;
  let b = seedWords[1] | 0;
  let c = seedWords[2] | 0;
  let d = seedWords[3] | 0;

  if ((a | b | c | d) === 0) {
    a = 1;
    b = 2;
    c = 3;
    d = 4;
  }

  const rotate = (value: number): number => (value << 7) | (value >>> 25);

  return {
    read(): number {
      const result = Math.imul(rotate(Math.imul(b, 5)), 9) >>> 0;

      const t = b << 9;
      c ^= a;
      d ^= b;
      b ^= c;
      a ^= d;
      c ^= t;

      d = rotate(d);

      return result;
    },
  };
}

/**
 * The accelerator: blocks of 4096 rolls, each block anchored by one HMAC draw.
 *
 * A 24-bit value per roll, which is far more resolution than a d6 needs; the
 * modulo bias is below 2^-24 and the statistical test in the suite measures the
 * faces, not the arithmetic.
 */
export function createFastDice(seed: string, matchId: string, startNonce = 0): DieSource {
  let blockNonce = startNonce;
  let generator: Xoshiro | null = null;
  let remaining = 0;
  let rolls = 0;

  const nextBlock = (): Xoshiro => {
    // Two 48-bit draws give 96 bits: four 24-bit words, one per state word.
    const high = Math.floor(rngAt(seed, matchId, blockNonce) * 2 ** 48);
    const low = Math.floor(rngAt(seed, matchId, blockNonce + 1) * 2 ** 48);
    blockNonce += 2;
    remaining = FAST_BLOCK_ROLLS;

    const words: [number, number, number, number] = [
      (high >>> 24) & 0xffffff,
      high & 0xffffff,
      (low >>> 24) & 0xffffff,
      low & 0xffffff,
    ];

    return xoshiro128(words);
  };

  return {
    get rolls(): number {
      return rolls;
    },
    roll(sides: number): number {
      if (remaining === 0 || generator === null) {
        generator = nextBlock();
      }
      remaining -= 1;
      rolls += 1;
      return 1 + (generator.read() % sides);
    },
  };
}
