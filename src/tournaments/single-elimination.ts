import { knockoutNextSeat, type TournamentFormat } from "./format.js";
import { bracketSize, firstRound } from "./seeding.js";
import type {
  DecidedPosition,
  FinishPlace,
  FormatEntrant,
  FormatOutcome,
  FormatPlan,
  PlannedPosition,
} from "./types.js";

/**
 * Single elimination, 2 to 64 entrants.
 *
 * Byes go to the best seeds, which falls out of the standard bracket order:
 * in a five player bracket the empty seats are the ones seed 6, 7 and 8 would
 * have taken, so seeds 1, 2 and 3 walk into round two and 4 plays 5.
 *
 * A position with one entrant and one bye is not played: the service advances
 * that entrant at bracket generation, so the bracket is already correct the
 * moment it is published.
 */

/** Rounds in a bracket of this size. */
function roundsFor(size: number): number {
  return Math.log2(size);
}

function plan(entrants: number): FormatPlan {
  const { size, byes, pairs, seeds } = firstRound(entrants);
  const rounds = roundsFor(size);
  const positions: PlannedPosition[] = [];

  // Round 1: seats filled from the seeding order.
  for (const pair of pairs) {
    positions.push({
      round: 1,
      slot: pair.slot,
      seat1Seed: pair.seat1Seed,
      seat2Seed: pair.seat2Seed,
      winnerToSlot: rounds > 1 ? Math.ceil(pair.slot / 2) : null,
    });
  }

  // Later rounds: slots exist from the start so the bracket can be drawn, but
  // their seats stay empty until a winner arrives.
  let slotsInRound = pairs.length;
  for (let round = 2; round <= rounds; round += 1) {
    slotsInRound = Math.floor(slotsInRound / 2);
    for (let slot = 1; slot <= slotsInRound; slot += 1) {
      positions.push({
        round,
        slot,
        seat1Seed: null,
        seat2Seed: null,
        winnerToSlot: round < rounds ? Math.ceil(slot / 2) : null,
      });
    }
  }

  return { format: "single_elimination", entrants, rounds, byes, seeds, positions };
}

/**
 * The finishing order.
 *
 * The champion is the final's winner. After that, players are ordered by how far
 * they got and then by seed, so two semi-finalists share third place in the sense
 * that matters (they went out in the same round) and the better seed is paid the
 * better place when only one prize is left. This is the ordinary knockout
 * convention and it keeps payouts deterministic.
 */
function summarise(
  plan: FormatPlan,
  positions: readonly DecidedPosition[],
  entrants: readonly FormatEntrant[],
): FormatOutcome {
  const final = plan.positions.find((position) => position.round === plan.rounds);
  const decided = new Map<string, DecidedPosition>();

  for (const position of positions) {
    if (position.winnerPlayerId !== null) {
      decided.set(`${String(position.round)}:${String(position.slot)}`, position);
    }
  }

  const eliminated: { playerId: string; round: number }[] = [];
  const exitRound = new Map<string, number>();

  for (const position of decided.values()) {
    if (position.loserPlayerId !== null) {
      exitRound.set(position.loserPlayerId, position.round);
      eliminated.push({ playerId: position.loserPlayerId, round: position.round });
    }
  }

  const finalDecided =
    final === undefined
      ? null
      : (decided.get(`${String(final.round)}:${String(final.slot)}`) ?? null);

  if (finalDecided === null || finalDecided.winnerPlayerId === null) {
    return { done: false, championPlayerId: null, places: [], eliminated };
  }

  const champion = finalDecided.winnerPlayerId;
  const seedOf = new Map(entrants.map((entrant) => [entrant.playerId, entrant.seed]));

  const others = entrants
    .filter((entrant) => entrant.playerId !== champion)
    .map((entrant) => ({
      playerId: entrant.playerId,
      round: exitRound.get(entrant.playerId) ?? 0,
      seed: entrant.seed,
    }))
    .sort((left, right) => {
      if (right.round !== left.round) {
        return right.round - left.round;
      }
      return left.seed - right.seed;
    });

  const places: FinishPlace[] = [
    { playerId: champion, place: 1, eliminatedRound: null },
    ...others.map((other, index) => ({
      playerId: other.playerId,
      place: index + 2,
      eliminatedRound: other.round,
    })),
  ];

  // Every entrant must appear exactly once: a player who somehow has no exit
  // round (a bracket edited by hand) is appended rather than dropped.
  const placed = new Set(places.map((place) => place.playerId));
  for (const entrant of entrants) {
    if (!placed.has(entrant.playerId)) {
      places.push({
        playerId: entrant.playerId,
        place: places.length + 1,
        eliminatedRound: seedOf.get(entrant.playerId) ?? 0,
      });
    }
  }

  return { done: true, championPlayerId: champion, places, eliminated };
}

/** The single-elimination strategy. */
export const singleEliminationFormat: TournamentFormat = {
  kind: "single_elimination",
  minPlayers: 2,
  maxPlayers: 64,
  plan,
  nextSeat: knockoutNextSeat,
  summarise,
};

/** Re-exported for the bracket tests, which check sizes from 2 to 64. */
export { bracketSize };
