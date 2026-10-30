/**
 * Default betting lines for Ludo markets.
 *
 * Every line sits on a half (.5) so that pushes are impossible on integer
 * game statistics such as turn counts, sixes, and captures. Keeping lines in
 * a dedicated frozen config allows trading and simulation logic to tune market
 * offerings without modifying settlement logic.
 */

export interface LudoLines {
  /** Over/under lines for winner's turns. */
  readonly winnerTurns: readonly number[];
  /**
   * Over/under lines for total match turns, counted in rounds: one turn each of
   * the seats in play. A four player game lasts about 420 rolls, which is 105
   * rounds; lines written in rolls would all be on the same side of every game.
   */
  readonly totalTurns: readonly number[];
  /** Over/under lines for total match sixes. */
  readonly totalSixes: readonly number[];
  /** Single over/under line for individual seat sixes. */
  readonly seatSixes: number;
  /** Over/under lines for total match captures. */
  readonly totalCaptures: readonly number[];
  /** Over/under lines for winner's captures. */
  readonly winnerCaptures: readonly number[];
  /** Over/under lines for rolls before first capture. */
  readonly rollsToFirstCapture: readonly number[];
  /** Over/under lines for tokens home at round 60. */
  readonly homeAtTurn60: readonly number[];
}

export const DEFAULT_LUDO_LINES: LudoLines = Object.freeze({
  winnerTurns: Object.freeze([
    40.5, 50.5, 60.5, 70.5, 80.5, 90.5, 100.5, 110.5, 120.5, 130.5, 140.5, 150.5,
  ]),
  totalTurns: Object.freeze([
    40.5, 50.5, 60.5, 70.5, 80.5, 90.5, 100.5, 110.5, 120.5, 130.5, 140.5, 150.5, 160.5, 170.5,
  ]),
  // A four player game rolls about 71 sixes (1 per 6 of ~424 rolls), so the
  // brief's 20 to 55 span sits entirely below the median. The lower lines are
  // kept because they are near free wins for a heavy under, and the span is
  // extended upward to keep the book tradeable around the median.
  totalSixes: Object.freeze([
    20.5, 25.5, 30.5, 35.5, 40.5, 45.5, 50.5, 55.5, 60.5, 65.5, 70.5, 75.5, 80.5, 85.5, 90.5,
  ]),
  seatSixes: 4.5,
  totalCaptures: Object.freeze([1.5, 4.5, 7.5, 10.5, 13.5, 16.5, 19.5, 22.5]),
  winnerCaptures: Object.freeze([0.5, 1.5, 2.5, 3.5, 4.5]),
  rollsToFirstCapture: Object.freeze([2.5, 6.5, 10.5, 14.5, 18.5, 22.5, 26.5]),
  homeAtTurn60: Object.freeze([0.5, 1.5, 2.5]),
});
