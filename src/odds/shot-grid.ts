import { z } from "zod";

/**
 * The grid the shot table is measured on.
 *
 * Kept apart from `shot-table.ts` so the calibration script can import the grid
 * without needing a table that it is about to write.
 */

/** Aim error levels, in degrees. Rookie to Master. */
export const AIM_ERROR_LEVELS = [6, 4, 2.5, 1.5, 0.8, 0.4] as const;

/**
 * Upper bounds of each distance bucket, in millimetres from the pocket. The last
 * one is the far corner of the board, so no shot falls outside the grid.
 */
export const DISTANCE_BUCKETS = [70, 130, 200, 280, 340] as const;

/** Upper bounds of each cut angle bucket, in degrees. */
export const CUT_BUCKETS = [12, 24, 36, 48, 62, 90] as const;

export const SHOTS_PER_CELL = 2_000;

export const tableSchema = z.object({
  version: z.literal(1),
  shotsPerCell: z.number().int().positive(),
  aimErrorDegrees: z.array(z.number()).length(6),
  distanceMaxMm: z.array(z.number()).length(5),
  cutMaxDegrees: z.array(z.number()).length(6),
  /** Indexed [aim error level][distance bucket][cut bucket], each 0 to 1. */
  pocketChance: z.array(z.array(z.array(z.number().min(0).max(1)))),
});

export type ShotTable = z.infer<typeof tableSchema>;
