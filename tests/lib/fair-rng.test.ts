import { describe, expect, it } from "vitest";
import {
  createSeededRng,
  generateSeed,
  hashSeed,
  verifySeedCommit,
} from "../../src/lib/fair-rng.js";

describe("seeded rng", () => {
  it("repeats the same stream for the same seed", () => {
    const first = createSeededRng("match-42");
    const second = createSeededRng("match-42");
    const values = Array.from({ length: 16 }, () => first.nextUint32());

    expect(values).toEqual(Array.from({ length: 16 }, () => second.nextUint32()));
  });

  it("gives different streams for different seeds", () => {
    const first = Array.from({ length: 8 }, (_, index) =>
      createSeededRng(`seed-${index}`).nextUint32(),
    );
    expect(new Set(first).size).toBe(first.length);
  });

  it("keeps nextInt inside its bounds and nextFloat inside [0, 1)", () => {
    const rng = createSeededRng("bounds");
    for (let index = 0; index < 500; index += 1) {
      const integer = rng.nextInt(3, 7);
      expect(Number.isInteger(integer)).toBe(true);
      expect(integer).toBeGreaterThanOrEqual(3);
      expect(integer).toBeLessThanOrEqual(7);

      const float = rng.nextFloat();
      expect(float).toBeGreaterThanOrEqual(0);
      expect(float).toBeLessThan(1);
    }
  });

  it("picks elements from a list, and refuses an empty one", () => {
    const rng = createSeededRng("pick");
    const items = ["white", "black", "queen"];

    for (let index = 0; index < 50; index += 1) {
      expect(items).toContain(rng.pick(items));
    }
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("forks a reproducible but independent stream", () => {
    const parent = createSeededRng("parent");
    const left = parent.fork("left");
    const right = createSeededRng("parent").fork("left");
    const other = createSeededRng("parent").fork("right");

    expect(left.nextUint32()).toBe(right.nextUint32());
    expect(createSeededRng("parent").fork("left").nextUint32()).not.toBe(other.nextUint32());
  });
});

describe("seed commitment", () => {
  it("verifies a revealed seed against its hash", () => {
    const seed = generateSeed();
    const commitment = hashSeed(seed);

    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySeedCommit(seed, commitment)).toBe(true);
    expect(verifySeedCommit(`${seed}0`, commitment)).toBe(false);
    expect(verifySeedCommit(seed, "00")).toBe(false);
  });
});
