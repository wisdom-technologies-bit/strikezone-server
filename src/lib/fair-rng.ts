import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Provably fair randomness for matches.
 *
 * AI_RULES.md hard rule 3: all game randomness comes from here, and no game,
 * bot or odds code calls Math.random.
 *
 * The flow:
 * 1. `createMatchSeed()` makes 32 random bytes. This is the only place a seed is
 *    created, and the only place `randomBytes` is used for seeds.
 * 2. `commitOf(seed)` is published before the match starts, so the server is
 *    locked in before anyone plays.
 * 3. Every random number the match needs is `rngAt(seed, matchId, nonce)`: an
 *    HMAC-SHA256 of the seed with `matchId:nonce`. The nonce simply counts up, so
 *    anyone holding the seed can re-derive every draw in order.
 * 4. At the end the seed is revealed and `verifyCommit` checks it against the
 *    commitment published at the start.
 *
 * `createSeededRng` is the separate, in-process generator used where the result
 * only has to be reproducible (the engine's own tests and the demo). It is not
 * what a match uses: a match uses the HMAC stream above.
 */

/** Anything that can produce a uniform number in [0, 1). */
export interface UniformRng {
  nextFloat(): number;
}

/** The seed length in bytes. */
export const MATCH_SEED_BYTES = 32;

const TWO_POW_32 = 4_294_967_296;
const TWO_POW_48 = 281_474_976_710_656;

// ---------------------------------------------------------------------------
// Seeds, commitments and per-draw randomness
// ---------------------------------------------------------------------------

/** A fresh 256-bit match seed as hex. The only seed source in the codebase. */
export function createMatchSeed(): string {
  return randomBytes(MATCH_SEED_BYTES).toString("hex");
}

/** The commitment published before the match: SHA-256 of the seed, as hex. */
export function commitOf(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

/**
 * Checks a revealed seed against the commitment published before play.
 *
 * A malformed commitment is simply a failed verification, never a throw: the
 * caller is comparing data it does not trust.
 */
export function verifyCommit(seed: string, commit: string): boolean {
  const expected = Buffer.from(commitOf(seed), "hex");
  const actual = Buffer.from(commit, "hex");

  if (expected.length !== actual.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/**
 * The match's random number at one position in its stream, uniform in [0, 1).
 *
 * HMAC-SHA256 keyed by the seed, over `matchId:nonce`; the first six digest bytes
 * are read as a 48-bit integer, which is exactly representable in a double.
 */
export function rngAt(seed: string, matchId: string, nonce: number): number {
  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new RangeError(`nonce must be a whole number of at least 0, got ${nonce}`);
  }
  const digest = createHmac("sha256", seed).update(`${matchId}:${nonce}`, "utf8").digest();
  return digest.readUIntBE(0, 6) / TWO_POW_48;
}

/** A stateful view of a match's stream: draws in order and counts them. */
export interface MatchRng extends UniformRng {
  /** The nonce the next draw will use. */
  readonly nonce: number;
  /** How many numbers have been drawn so far. */
  readonly draws: number;
  /** The next uniform number in [0, 1), then advances. */
  nextFloat(): number;
  /** A standard normal number, drawn from two uniforms. */
  gaussian(): number;
}

/**
 * Wraps `rngAt` in a counter, so a bot or a referee can draw repeatedly without
 * tracking nonces, and `draws` records exactly how much randomness a match used.
 */
export function createMatchRng(seed: string, matchId: string, startNonce = 0): MatchRng {
  let nonce = startNonce;
  let draws = 0;

  const rng: MatchRng = {
    get nonce(): number {
      return nonce;
    },
    get draws(): number {
      return draws;
    },
    nextFloat(): number {
      const value = rngAt(seed, matchId, nonce);
      nonce += 1;
      draws += 1;
      return value;
    },
    gaussian(): number {
      return gaussian(rng);
    },
  };

  return rng;
}

/**
 * Standard normal from two uniforms (Box-Muller).
 *
 * `u1` is floored at the smallest positive double so `log(0)` can never produce
 * an infinity, whatever generator is passed in.
 */
export function gaussian(rng: UniformRng): number {
  let first = rng.nextFloat();
  const second = rng.nextFloat();

  if (!(first > Number.EPSILON)) {
    first = Number.EPSILON;
  }

  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

// ---------------------------------------------------------------------------
// In-process generator, for reproducible tests and the demo
// ---------------------------------------------------------------------------

export interface SeededRng extends UniformRng {
  /** Raw 32-bit output of the generator. */
  nextUint32(): number;
  /** Uniform integer in [min, max], both inclusive. */
  nextInt(min: number, max: number): number;
  /** Uniform element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** A separate stream derived from this seed and a label. */
  fork(label: string): SeededRng;
}

function seedWords(seed: string): [number, number, number, number] {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return [
    digest.readUInt32LE(0),
    digest.readUInt32LE(4),
    digest.readUInt32LE(8),
    digest.readUInt32LE(12),
  ];
}

/**
 * The in-process generator: an independent implementation of the public sfc32
 * algorithm, seeded from a SHA-256 digest of the seed text.
 */
export function createSeededRng(seed: string | number): SeededRng {
  const seedText = String(seed);
  const words = seedWords(seedText);

  let a = words[0];
  let b = words[1];
  let c = words[2];
  let d = words[3];

  const nextUint32 = (): number => {
    const sum = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + sum) | 0;
    return sum >>> 0;
  };

  // Discard the first outputs so that nearby seeds are not correlated.
  for (let index = 0; index < 12; index += 1) {
    nextUint32();
  }

  const nextFloat = (): number => nextUint32() / TWO_POW_32;

  return {
    nextUint32,
    nextFloat,
    nextInt(min: number, max: number): number {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`nextInt needs integers with min <= max, got ${min} and ${max}`);
      }
      return min + Math.floor(nextFloat() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("pick needs a non-empty list");
      }
      const chosen = items[Math.floor(nextFloat() * items.length)];
      if (chosen === undefined) {
        throw new RangeError("pick could not choose an element");
      }
      return chosen;
    },
    fork(label: string): SeededRng {
      return createSeededRng(`${seedText}:${label}`);
    },
  };
}
