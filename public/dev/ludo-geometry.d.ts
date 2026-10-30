/**
 * Types for the dev viewer's geometry module.
 *
 * The module is plain JavaScript in `public/`, loaded by the page in the browser;
 * this declaration is what lets the geometry test in `tests/public` import it under
 * strict TypeScript.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export declare const SAFE_CELLS: readonly number[];
export declare const RING_CELLS: number;
export declare const CELLS_PER_SIDE: number;
export declare const PROGRESS_ON_RING: number;
export declare const PROGRESS_LANE_START: number;
export declare const PROGRESS_HOME: number;

export declare function buildRing(size?: number, margin?: number): Point[];
export declare function yardCorner(seatIndex: number, size?: number, margin?: number): Point;
export declare function yardSlot(
  seatIndex: number,
  token: number,
  size?: number,
  margin?: number,
): Point;
export declare function pointFor(
  seatIndex: number,
  progress: number,
  token: number,
  size?: number,
  margin?: number,
): Point;
export declare function pathBetween(
  seatIndex: number,
  from: number,
  to: number,
  token: number,
  size?: number,
): Point[];
