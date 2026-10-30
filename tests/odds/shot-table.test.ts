import { describe, expect, it } from "vitest";
import {
  AIM_ERROR_LEVELS,
  SHOT_TABLE,
  readShotTable,
  aimErrorLevel,
  cutBucket,
  distanceBucket,
} from "../../src/odds/shot-table.js";
import { botSkill, shrinkToPrior, CLUB_SKILL, foulRateFor } from "../../src/odds/skill.js";

describe("the calibrated shot table", () => {
  it("loads the same numbers from the committed JSON and the generated module", () => {
    const onDisk = readShotTable();

    expect(onDisk.version).toBe(SHOT_TABLE.version);
    expect(onDisk.pocketChance).toEqual(SHOT_TABLE.pocketChance);
    expect(onDisk.shotsPerCell).toBe(2_000);
  });

  it("holds a probability for every cell of the grid", () => {
    expect(SHOT_TABLE.pocketChance).toHaveLength(AIM_ERROR_LEVELS.length);

    for (const byDistance of SHOT_TABLE.pocketChance) {
      expect(byDistance).toHaveLength(5);
      for (const byCut of byDistance) {
        expect(byCut).toHaveLength(6);
        for (const chance of byCut) {
          expect(chance).toBeGreaterThanOrEqual(0);
          expect(chance).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("rewards a better aim: the mean chance rises as the aim error falls", () => {
    const means = SHOT_TABLE.pocketChance.map(
      (byDistance) =>
        byDistance.flat().reduce((sum, chance) => sum + chance, 0) /
        Math.max(1, byDistance.flat().length),
    );

    const worst = means[0] ?? 0;
    const best = means[means.length - 1] ?? 0;
    expect(best).toBeGreaterThan(worst * 1.4);
    expect(best).toBeLessThan(0.6);

    // Every level is better than a six degree aim error, and none is above 40%.
    for (const mean of means) {
      expect(mean).toBeGreaterThan(worst - 0.001);
      expect(mean).toBeLessThan(0.4);
    }
  });

  it("keeps every cell inside a plausible band", () => {
    // Cell-level monotonicity is NOT claimed: shots that cannot be played from a
    // legal baseline are filled from their neighbours, so individual adjacent
    // cells can invert. What is claimed is that no cell says a pot is impossible
    // and none says it is a certainty.
    for (const byDistance of SHOT_TABLE.pocketChance) {
      for (const byCut of byDistance) {
        for (const chance of byCut) {
          expect(chance).toBeGreaterThanOrEqual(0.02);
          expect(chance).toBeLessThanOrEqual(0.9);
        }
      }
    }
  });

  it("buckets the grid edges without falling off it", () => {
    expect(distanceBucket(0)).toBe(0);
    expect(distanceBucket(1_000)).toBe(4);
    expect(cutBucket(0)).toBe(0);
    expect(cutBucket(89)).toBe(5);
    expect(aimErrorLevel(6)).toBe(0);
    expect(aimErrorLevel(0.4)).toBe(5);
    expect(aimErrorLevel(99)).toBe(0);
  });
});

describe("player skill", () => {
  it("gives a bot its published numbers", () => {
    expect(botSkill("rookie").aimErrorDegrees).toBe(4);
    expect(botSkill("club").aimErrorDegrees).toBe(2);
    expect(botSkill("master").aimErrorDegrees).toBe(0.8);
    expect(botSkill("master").foulRate).toBeLessThan(botSkill("rookie").foulRate);
  });

  it("shrinks a handful of matches towards Club", () => {
    const sharp = { aimErrorDegrees: 0.5, selectionQuality: 0.95, foulRate: 0.01 };
    const oneMatch = shrinkToPrior([sharp]);
    const tenMatches = shrinkToPrior(new Array<typeof sharp>(10).fill(sharp));

    // One match barely moves the estimate; ten matches nearly arrive at it.
    expect(oneMatch.aimErrorDegrees).toBeLessThan(CLUB_SKILL.aimErrorDegrees);
    expect(oneMatch.aimErrorDegrees).toBeGreaterThan(tenMatches.aimErrorDegrees);
    expect(tenMatches.aimErrorDegrees).toBeCloseTo(0.5, 6);
    expect(oneMatch.matches).toBe(1);
  });

  it("leaves a player with no history at Club", () => {
    expect(shrinkToPrior([])).toEqual(CLUB_SKILL);
  });

  it("reads fouls off aim and selection, and keeps them sane", () => {
    expect(foulRateFor(6, 0.4)).toBeGreaterThan(foulRateFor(0.8, 0.95));
    expect(foulRateFor(0.4, 1)).toBeLessThan(0.05);
    expect(foulRateFor(90, 0)).toBeLessThanOrEqual(0.15);
  });
});
