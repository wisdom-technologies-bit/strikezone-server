import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Seeded, reproducible random numbers for game code.
 *
 * AI_RULES.md forbids Math.random in game, bot and odds code: everything random
 * must come from here, so that a match can be replayed and so that a seed can be
 * committed to before play and revealed afterwards. This is an independent
 * implementation of the public sfc32 generator, seeded from a SHA-256 digest of
 * the seed text; no third-party code is involved.
 */

export interface SeededRng {
  /** Raw 32-bit output of the generator. */
  nextUint32(): number;
  /** Uniform in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [min, max], both inclusive. */
  nextInt(min: number, max: number): number;
  /** Uniform element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** A separate stream derived from this seed and a label. */
  fork(label: string): SeededRng;
}

const TWO_POW_32 = 4_294_967_296;

function seedWords(seed: string): [number, number, number, number] {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return [
    digest.readUInt32LE(0),
    digest.readUInt32LE(4),
    digest.readUInt32LE(8),
    digest.readUInt32LE(12),
  ];
}

/** Creates the generator for a seed. The same seed always yields the same stream. */
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

/** A fresh 256-bit seed as hex. Uses the platform CSPRNG, not a game generator. */
export function generateSeed(): string {
  return randomBytes(32).toString("hex");
}

/** The commitment published before a match: SHA-256 of the seed, as hex. */
export function hashSeed(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

/** Checks a revealed seed against the commitment published before play. */
export function verifySeedCommit(seed: string, commitment: string): boolean {
  const expected = Buffer.from(hashSeed(seed), "hex");
  const actual = Buffer.from(commitment, "hex");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
