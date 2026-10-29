import { describe, expect, it } from "vitest";
import {
  commitOf,
  createMatchRng,
  createMatchSeed,
  createSeededRng,
  gaussian,
  MATCH_SEED_BYTES,
  rngAt,
  verifyCommit,
} from "../../src/lib/fair-rng.js";

const SEED = "b3d1c0a7a4e94d6f9c2f5c0f0b7a48d9f2c1e6a4b8d3c5e7f9a0b1c2d3e4f5a6";
const MATCH = "1f0b7c62-6a1e-4b8d-9a44-2f4c8d1b0e77";

describe("match seeds and commitments", () => {
  it("creates a 32-byte hex seed", () => {
    const seed = createMatchSeed();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(seed, "hex")).toHaveLength(MATCH_SEED_BYTES);
    expect(createMatchSeed()).not.toBe(seed);
  });

  it("commits to a seed with SHA-256 and verifies it back", () => {
    const seed = createMatchSeed();
    const commit = commitOf(seed);

    expect(commit).toMatch(/^[0-9a-f]{64}$/);
    expect(commitOf(seed)).toBe(commit);
    expect(verifyCommit(seed, commit)).toBe(true);
  });

  it("rejects a different seed, a different commitment and rubbish", () => {
    const seed = createMatchSeed();
    const commit = commitOf(seed);

    expect(verifyCommit(`${seed}0`, commit)).toBe(false);
    expect(verifyCommit(seed, commitOf("something else"))).toBe(false);
    expect(verifyCommit(seed, "nonsense")).toBe(false);
    expect(verifyCommit(seed, "")).toBe(false);
    expect(verifyCommit(seed, commit.slice(0, 32))).toBe(false);
  });
});

describe("rngAt", () => {
  it("is deterministic for the same seed, match and nonce", () => {
    expect(rngAt(SEED, MATCH, 7)).toBe(rngAt(SEED, MATCH, 7));
  });

  it("changes with the nonce, the match and the seed", () => {
    const values = [
      rngAt(SEED, MATCH, 0),
      rngAt(SEED, MATCH, 1),
      rngAt(SEED, "another-match", 0),
      rngAt(`${SEED}ff`, MATCH, 0),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it("stays inside [0, 1) and never repeats a value", () => {
    const seen = new Set<number>();
    for (let nonce = 0; nonce < 2_000; nonce += 1) {
      const value = rngAt(SEED, MATCH, nonce);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      seen.add(value);
    }
    expect(seen.size).toBe(2_000);
  });

  it("refuses a negative or fractional nonce", () => {
    expect(() => rngAt(SEED, MATCH, -1)).toThrow(RangeError);
    expect(() => rngAt(SEED, MATCH, 1.5)).toThrow(RangeError);
  });

  it("is uniform: chi-square over 100000 draws", () => {
    const draws = 100_000;
    const buckets = 20;
    const observed = new Array<number>(buckets).fill(0);

    for (let nonce = 0; nonce < draws; nonce += 1) {
      const index = Math.floor(rngAt(SEED, MATCH, nonce) * buckets);
      observed[index] = (observed[index] ?? 0) + 1;
    }

    const expected = draws / buckets;
    let chiSquare = 0;
    for (const count of observed) {
      chiSquare += (count - expected) ** 2 / expected;
    }

    // 20 buckets, 19 degrees of freedom: the 0.1% critical value is 43.82.
    console.log(
      `fair-rng chi-square over ${draws} draws: ${chiSquare.toFixed(2)} (critical 43.82 at p=0.001)`,
    );
    expect(observed.every((count) => count > 0)).toBe(true);
    expect(chiSquare).toBeLessThan(43.82);
  });
});

describe("createMatchRng", () => {
  it("walks the same stream as rngAt and counts draws", () => {
    const rng = createMatchRng(SEED, MATCH);

    expect(rng.draws).toBe(0);
    expect(rng.nonce).toBe(0);
    expect(rng.nextFloat()).toBe(rngAt(SEED, MATCH, 0));
    expect(rng.nextFloat()).toBe(rngAt(SEED, MATCH, 1));
    expect(rng.draws).toBe(2);
    expect(rng.nonce).toBe(2);
  });

  it("replays identically from the same seed and resumes from a nonce", () => {
    const first = createMatchRng(SEED, MATCH);
    const second = createMatchRng(SEED, MATCH);
    const sequence = Array.from({ length: 32 }, () => first.nextFloat());

    expect(sequence).toEqual(Array.from({ length: 32 }, () => second.nextFloat()));
    expect(createMatchRng(SEED, MATCH, 32).nextFloat()).toBe(rngAt(SEED, MATCH, 32));
  });
});

describe("gaussian", () => {
  it("has mean near zero and standard deviation near one", () => {
    const rng = createMatchRng(SEED, MATCH, 10_000);
    const draws = 20_000;
    let sum = 0;
    let sumSquares = 0;

    for (let index = 0; index < draws; index += 1) {
      const value = rng.gaussian();
      sum += value;
      sumSquares += value * value;
    }

    const mean = sum / draws;
    const variance = sumSquares / draws - mean * mean;

    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(Math.sqrt(variance) - 1)).toBeLessThan(0.05);
    expect(rng.draws).toBe(draws * 2);
  });

  it("never returns a non-finite number when a uniform is zero", () => {
    const zeros = { nextFloat: (): number => 0 };
    const value = gaussian(zeros);

    expect(Number.isFinite(value)).toBe(true);
  });
});

describe("in-process generator", () => {
  it("repeats the same stream for the same seed", () => {
    const first = createSeededRng("match-42");
    const second = createSeededRng("match-42");
    const values = Array.from({ length: 16 }, () => first.nextUint32());

    expect(values).toEqual(Array.from({ length: 16 }, () => second.nextUint32()));
  });

  it("keeps nextInt inside its bounds and picks from a list", () => {
    const rng = createSeededRng("bounds");
    const items = ["white", "black", "queen"];

    for (let index = 0; index < 200; index += 1) {
      const integer = rng.nextInt(3, 7);
      expect(integer).toBeGreaterThanOrEqual(3);
      expect(integer).toBeLessThanOrEqual(7);
      expect(items).toContain(rng.pick(items));
    }
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("forks a reproducible stream", () => {
    const left = createSeededRng("parent").fork("left");
    const sameLeft = createSeededRng("parent").fork("left");

    expect(left.nextUint32()).toBe(sameLeft.nextUint32());
  });
});
