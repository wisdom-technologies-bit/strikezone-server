import type { LudoState } from "../engines/ludo/index.js";
import { homeCount } from "../engines/ludo/index.js";
import type { MatchResult, SeatNumber } from "../lib/match-repository.js";

/**
 * One seat as the board holds it: the number the database gave it, and the index
 * the engine plays it on.
 */
export interface BoardSeat {
  readonly seat: SeatNumber;
  readonly engineSeat: number;
}

/** What a signed result has to agree with to be signed at all. */
export interface ResultCheck {
  readonly result: MatchResult;
  readonly state: LudoState;
  readonly seats: readonly BoardSeat[];
}

/**
 * Why a result cannot be signed, or null when it can.
 *
 * This is a pure reading of the board: no clock, no repository, no counters that
 * advance. A signed result is what the books settle against, so the useful
 * failure is here, naming the mismatch, rather than in the verifier later with a
 * token count and no explanation.
 *
 * Rules, all of which the room path has broken at least once:
 *
 * - every seat in the match is named exactly once, in the finishing order;
 * - the token count is recorded for every seat;
 * - a recorded count matches the board;
 * - every place but the last brought all its tokens home, because the last place
 *   is the seat still racing when the others finished.
 */
export function resultProblem(input: ResultCheck): string | null {
  const { result, state, seats } = input;
  const perPlayer = state.config.tokensPerPlayer;
  const order = result.finishingOrder ?? [];
  const home = result.tokensHome ?? [];

  const seatNumbers = seats.map((entry) => entry.seat);
  if (new Set(seatNumbers).size !== seatNumbers.length) {
    return "the seat list repeats a seat";
  }
  if (order.length !== seatNumbers.length) {
    return `the finishing order names ${String(order.length)} of ${String(seatNumbers.length)} seats`;
  }
  if (home.length !== seatNumbers.length) {
    return `the result counts tokens home for ${String(home.length)} of ${String(seatNumbers.length)} seats`;
  }
  if (result.shots <= 0) {
    return "the result counts no moves";
  }
  if (new Set(order).size !== order.length) {
    return "the finishing order names a seat twice";
  }

  const engineOf = new Map(seats.map((entry) => [entry.seat, entry.engineSeat]));

  for (let position = 0; position < order.length; position += 1) {
    const seat = order[position];
    if (seat === undefined) {
      continue;
    }

    const engineSeat = engineOf.get(seat);
    if (engineSeat === undefined) {
      return `the finishing order names seat ${String(seat)}, which is not in this match`;
    }

    // `home` is per seat, `order` is per finishing place, so the count is looked
    // up by seat rather than by position.
    const recorded = home[seatNumbers.indexOf(seat)] ?? -1;
    const onBoard = homeCount(state, engineSeat);
    if (recorded !== onBoard) {
      return `seat ${String(seat)} is recorded with ${String(recorded)} tokens home and has ${String(onBoard)}`;
    }

    const isLastPlace = position === order.length - 1;
    if (!isLastPlace && recorded !== perPlayer) {
      return `seat ${String(seat)} is placed ${String(position + 1)} with ${String(recorded)} of ${String(perPlayer)} tokens home`;
    }
  }

  return null;
}
