/**
 * The lines every market is offered on.
 *
 * These are the defaults the engine prices and the API publishes. They live in
 * one place so a trader can move a line without touching settlement code, and so
 * the number of priced selections is predictable (about 230 for a Carrom match).
 */

export interface CarromLines {
  /** Board-winner markets, one per board. */
  readonly boardWinnerBoards: readonly number[];
  /** Points handicaps, whites giving the start. */
  readonly pointsHandicap: readonly number[];
  readonly boardsHandicap: readonly number[];
  /** Winning margin bands, inclusive. */
  readonly marginBands: readonly (readonly [number, number])[];
  /** Loser's final score bands, inclusive. */
  readonly loserScoreBands: readonly (readonly [number, number])[];
  readonly totalBoards: readonly number[];
  readonly exactBoards: readonly number[];
  readonly totalPoints: readonly number[];
  readonly playerPoints: readonly number[];
  readonly boardOnePoints: readonly number[];
  readonly boardOneCoins: readonly number[];
  readonly totalFouls: readonly number[];
  readonly matchMinutes: readonly number[];
  readonly boardOneShots: readonly number[];
}

const range = (from: number, to: number, step: number): number[] => {
  const values: number[] = [];
  for (let value = from; value <= to + 1e-9; value += step) {
    values.push(Number(value.toFixed(1)));
  }
  return values;
};

export const DEFAULT_CARROM_LINES: CarromLines = Object.freeze({
  boardWinnerBoards: [1, 2, 3, 4, 5, 6],
  pointsHandicap: range(1.5, 14.5, 1),
  boardsHandicap: [0.5, 1.5, 2.5],
  marginBands: [
    [1, 5] as const,
    [6, 10] as const,
    [11, 15] as const,
    [16, 20] as const,
    [21, 99] as const,
  ],
  loserScoreBands: [
    [0, 4] as const,
    [5, 9] as const,
    [10, 14] as const,
    [15, 19] as const,
    [20, 24] as const,
  ],
  totalBoards: range(2.5, 7.5, 1),
  exactBoards: [2, 3, 4, 5, 6, 7, 8],
  totalPoints: range(20.5, 75.5, 5),
  playerPoints: range(10.5, 35.5, 5),
  boardOnePoints: range(1.5, 8.5, 1),
  boardOneCoins: range(2.5, 5.5, 1),
  totalFouls: range(0.5, 5.5, 1),
  matchMinutes: range(6.5, 20.5, 2),
  boardOneShots: [15.5, 22.5, 29.5, 36.5],
});
