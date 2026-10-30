// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CELLS_PER_SIDE,
  PROGRESS_HOME,
  PROGRESS_LANE_START,
  PROGRESS_ON_RING,
  RING_CELLS,
  SAFE_CELLS,
  buildRing,
  pathBetween,
  pointFor,
  yardSlot,
} from "../../public/dev/ludo-geometry.js";

/**
 * The dev viewer's board geometry.
 *
 * A viewer that draws a token in the wrong square is worse than no viewer, so the
 * arithmetic lives in a module of its own and is checked here: the ring is the
 * engine's 52 cells, the four starts are thirteen apart, the home lane runs
 * strictly towards the middle, and nothing is ever drawn at NaN.
 */

const SIZE = 620;

describe("the ring", () => {
  it("has 52 cells, thirteen a side", () => {
    const ring = buildRing(SIZE);
    expect(ring).toHaveLength(RING_CELLS);
    expect(RING_CELLS).toBe(CELLS_PER_SIDE * 4);
  });

  it("starts each seat thirteen cells after the last, like the engine", () => {
    const ring = buildRing(SIZE);
    expect(ring[0]).toEqual({ x: 24, y: 24 });
    expect(ring[13]).toEqual({ x: SIZE - 24, y: 24 });
    expect(ring[26]).toEqual({ x: SIZE - 24, y: SIZE - 24 });
    expect(ring[39]).toEqual({ x: 24, y: SIZE - 24 });

    for (let seat = 0; seat < 4; seat += 1) {
      expect(pointFor(seat, 0, 0, SIZE)).toEqual(ring[seat * CELLS_PER_SIDE]);
    }
  });

  it("marks eight safe cells, the starts and one more each", () => {
    expect(SAFE_CELLS).toEqual([0, 8, 13, 21, 26, 34, 39, 47]);
    expect(SAFE_CELLS).toHaveLength(8);
  });
});

describe("a token's position", () => {
  it("is on the ring for progress 0 to 50", () => {
    const ring = buildRing(SIZE);
    for (let seat = 0; seat < 4; seat += 1) {
      for (let progress = 0; progress <= PROGRESS_ON_RING; progress += 1) {
        const point = pointFor(seat, progress, 0, SIZE);
        const cell = ring[(seat * CELLS_PER_SIDE + progress) % RING_CELLS];
        expect(point).toEqual(cell);
      }
    }
  });

  it("wraps a full lap back to the start cell", () => {
    const start = pointFor(1, 0, 0, SIZE);
    const lap = pointFor(1, 51, 0, SIZE);
    expect(lap).not.toEqual(start);
    // Progress 51 is the first lane cell, one step in from the corner.
    const corner = buildRing(SIZE)[13] ?? { x: 0, y: 0 };
    expect(Math.abs(lap.x - corner.x) + Math.abs(lap.y - corner.y)).toBeGreaterThan(0);
  });

  it("runs the home lane strictly towards the middle", () => {
    const centre = { x: SIZE / 2, y: SIZE / 2 };
    for (let seat = 0; seat < 4; seat += 1) {
      let previous = Number.POSITIVE_INFINITY;
      for (let progress = PROGRESS_LANE_START; progress < PROGRESS_HOME; progress += 1) {
        const point = pointFor(seat, progress, 0, SIZE);
        const distance = Math.hypot(point.x - centre.x, point.y - centre.y);
        expect(distance).toBeLessThan(previous);
        previous = distance;
      }
    }
  });

  it("keeps a home token inside the middle", () => {
    for (let seat = 0; seat < 4; seat += 1) {
      const point = pointFor(seat, PROGRESS_HOME, 0, SIZE);
      const corner = buildRing(SIZE)[seat * CELLS_PER_SIDE] ?? { x: 0, y: 0 };
      const toCorner = Math.hypot(point.x - corner.x, point.y - corner.y);
      const toCentre = Math.hypot(point.x - SIZE / 2, point.y - SIZE / 2);
      expect(toCentre).toBeLessThan(toCorner);
      expect(toCentre).toBeLessThan(SIZE / 4);
    }
  });

  it("puts a token in the yard on a yard slot", () => {
    for (let seat = 0; seat < 4; seat += 1) {
      for (let token = 0; token < 4; token += 1) {
        expect(pointFor(seat, -1, token, SIZE)).toEqual(yardSlot(seat, token, SIZE));
      }
    }
  });

  it("never produces a coordinate that is not a number", () => {
    for (let seat = 0; seat < 4; seat += 1) {
      for (let progress = -1; progress <= PROGRESS_HOME; progress += 1) {
        for (let token = 0; token < 4; token += 1) {
          const point = pointFor(seat, progress, token, SIZE);
          expect(Number.isFinite(point.x)).toBe(true);
          expect(Number.isFinite(point.y)).toBe(true);
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(SIZE);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(SIZE);
        }
      }
    }
  });
});

describe("the path a move animates", () => {
  it("visits every cell between two progress values", () => {
    const points = pathBetween(0, 3, 7, 0, SIZE);
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual(pointFor(0, 3, 0, SIZE));
    expect(points.at(-1)).toEqual(pointFor(0, 7, 0, SIZE));
  });

  it("works for an entry from the yard and a jump home", () => {
    expect(pathBetween(2, -1, 0, 1, SIZE)).toHaveLength(2);
    expect(pathBetween(2, 55, 57, 1, SIZE)).toHaveLength(3);
  });
});
