import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHOT_TABLE_DATA } from "./data/shot-table.generated.js";
import {
  AIM_ERROR_LEVELS,
  CUT_BUCKETS,
  DISTANCE_BUCKETS,
  SHOTS_PER_CELL,
  tableSchema,
  type ShotTable,
} from "./shot-grid.js";

/**
 * The shot table: how often a shot that tries to pot actually does.
 *
 * One number per cell of a three-dimensional grid: distance from the coin to the
 * pocket (5 buckets), cut angle between the striker's path and the coin's path
 * (6 buckets), and the shooter's aim error (6 levels). Every number was measured
 * by playing real shots through `src/engines/carrom`, 2000 per cell, so the fast
 * model and the engine agree about what a good player can do.
 *
 * The table is generated, never edited by hand:
 *
 *     npm run odds:calibrate
 *
 * which writes both `data/shot-table.json` (the record of the measurement) and
 * `data/shot-table.generated.ts` (the same numbers as a typed module, so the
 * server imports them without needing files copied into `dist`).
 */

export { AIM_ERROR_LEVELS, CUT_BUCKETS, DISTANCE_BUCKETS, SHOTS_PER_CELL };
export type { ShotTable };

/** The committed table, validated once at import. */
export const SHOT_TABLE: ShotTable = tableSchema.parse(SHOT_TABLE_DATA);

/** Reads the table from disk instead of the compiled module, for the tools. */
export function readShotTable(path?: string): ShotTable {
  const file = path ?? fileURLToPath(new URL("./data/shot-table.json", import.meta.url));
  return tableSchema.parse(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

/** The level whose aim error is closest to this one. */
export function aimErrorLevel(aimErrorDegrees: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let index = 0; index < AIM_ERROR_LEVELS.length; index += 1) {
    const gap = Math.abs((AIM_ERROR_LEVELS[index] ?? 6) - aimErrorDegrees);
    if (gap < bestGap) {
      best = index;
      bestGap = gap;
    }
  }
  return best;
}

/** The bucket a raw distance falls in. */
export function distanceBucket(distanceMm: number): number {
  const distance = Math.max(0, distanceMm);
  for (let index = 0; index < DISTANCE_BUCKETS.length; index += 1) {
    if (distance <= (DISTANCE_BUCKETS[index] ?? Infinity)) {
      return index;
    }
  }
  return DISTANCE_BUCKETS.length - 1;
}

/** The bucket a raw cut angle falls in. */
export function cutBucket(cutDegrees: number): number {
  const cut = Math.max(0, cutDegrees);
  for (let index = 0; index < CUT_BUCKETS.length; index += 1) {
    if (cut <= (CUT_BUCKETS[index] ?? 90)) {
      return index;
    }
  }
  return CUT_BUCKETS.length - 1;
}

/**
 * P(coin in, given the shooter's aim error, the distance and the cut).
 *
 * Outside the measured grid the nearest cell is used, and the answer is clamped
 * to a sane band: a shot that cannot miss is not a thing, and neither is one
 * that can never drop.
 */
export function pocketChance(
  table: ShotTable,
  aimErrorDegrees: number,
  distanceMm: number,
  cutDegrees: number,
): number {
  const skill = table.pocketChance[aimErrorLevel(aimErrorDegrees)];
  const byDistance = skill?.[distanceBucket(distanceMm)];
  const raw = byDistance?.[cutBucket(cutDegrees)] ?? 0;

  return Math.min(0.97, Math.max(0.01, raw));
}
