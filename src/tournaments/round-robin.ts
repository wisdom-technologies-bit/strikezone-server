import type { TournamentFormat } from "./format.js";
import type {
  DecidedPosition,
  FinishPlace,
  FormatEntrant,
  FormatOutcome,
  FormatPlan,
  PlannedPosition,
} from "./types.js";

/**
 * Round robin, 3 to 8 entrants.
 *
 * Every pairing is scheduled up front with the circle method: one entrant is
 * fixed and the rest rotate, so n players produce n-1 rounds (n rounds with a
 * bye when the count is odd) and every pair meets exactly once.
 *
 * Standings are ordered by wins, then by the head-to-head result between two
 * players who are level, then by point difference, then by seed. Point
 * difference is the reason a result records the score of both seats rather than
 * only the winner.
 */

/** One round of pairings, by entrant index into the seeded list. */
function circleRounds(entrants: number): readonly (readonly (readonly [number, number])[])[] {
  const odd = entrants % 2 !== 0;
  const seats = odd ? entrants + 1 : entrants;
  // With an odd count one seat is a phantom: whoever is drawn against it sits
  // the round out. With an even count there is no phantom at all, and using
  // `seats - 1` as one would silently drop a real player from every round.
  const byeIndex = odd ? seats - 1 : -1;
  const order = Array.from({ length: seats }, (_unused, index) => index);
  const rounds: (readonly [number, number])[][] = [];

  for (let round = 0; round < seats - 1; round += 1) {
    const pairs: (readonly [number, number])[] = [];
    for (let index = 0; index < seats / 2; index += 1) {
      const left = order[index];
      const right = order[seats - 1 - index];
      if (left === undefined || right === undefined) {
        continue;
      }
      if (left === byeIndex || right === byeIndex) {
        continue;
      }
      pairs.push([left, right]);
    }
    rounds.push(pairs);

    // Rotate every seat but the first, one step clockwise.
    const fixed = order[0];
    const rotating = order.slice(1);
    const last = rotating.pop();
    if (fixed !== undefined && last !== undefined) {
      rotating.unshift(last);
      order.splice(0, order.length, fixed, ...rotating);
    }
  }

  return rounds;
}

function plan(entrants: number): FormatPlan {
  const rounds = circleRounds(entrants);
  const positions: PlannedPosition[] = [];

  rounds.forEach((pairs, roundIndex) => {
    pairs.forEach((pair, pairIndex) => {
      const [left, right] = pair;
      positions.push({
        round: roundIndex + 1,
        slot: pairIndex + 1,
        // Entrant indexes are seeds: the circle works on the seeded list.
        seat1Seed: left + 1,
        seat2Seed: right + 1,
        winnerToSlot: null,
      });
    });
  });

  const seeds = Array.from({ length: entrants }, (_unused, index) => index + 1);

  return {
    format: "round_robin",
    entrants,
    rounds: rounds.length,
    byes: entrants % 2 === 0 ? 0 : 1,
    seeds,
    positions,
  };
}

/** A player's row in the table. */
interface TableRow {
  forPoints: number;
  againstPoints: number;
  wins: number;
}

/** Points and wins per player, read off the seats each result recorded. */
function buildTable(positions: readonly DecidedPosition[]): Map<string, TableRow> {
  const table = new Map<string, TableRow>();
  const rowOf = (playerId: string): TableRow => {
    const existing = table.get(playerId);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: TableRow = { forPoints: 0, againstPoints: 0, wins: 0 };
    table.set(playerId, fresh);
    return fresh;
  };

  for (const position of positions) {
    if (position.winnerPlayerId === null) {
      continue;
    }
    const seat1Points = position.points?.seat1 ?? 0;
    const seat2Points = position.points?.seat2 ?? 0;

    if (position.seat1PlayerId !== null) {
      const row = rowOf(position.seat1PlayerId);
      row.forPoints += seat1Points;
      row.againstPoints += seat2Points;
      if (position.winnerPlayerId === position.seat1PlayerId) {
        row.wins += 1;
      }
    }

    if (position.seat2PlayerId !== null) {
      const row = rowOf(position.seat2PlayerId);
      row.forPoints += seat2Points;
      row.againstPoints += seat1Points;
      if (position.winnerPlayerId === position.seat2PlayerId) {
        row.wins += 1;
      }
    }
  }

  return table;
}

/**
 * The standings.
 *
 * Wins decide first. Then the head-to-head record *inside the group of players
 * level on wins*, which is what "head to head" means and what keeps the order
 * consistent: with three players on the same number of wins who each beat one of
 * the others, a plain pairwise comparison would contradict itself, so the group
 * score comes out equal and point difference breaks the cycle. After that, seed.
 */
function summarise(
  plan: FormatPlan,
  positions: readonly DecidedPosition[],
  entrants: readonly FormatEntrant[],
): FormatOutcome {
  const decided = positions.filter((position) => position.winnerPlayerId !== null);
  const done = decided.length === plan.positions.length;
  const table = buildTable(decided);

  const seedOf = new Map(entrants.map((entrant) => [entrant.playerId, entrant.seed]));
  const winsOf = (playerId: string): number => table.get(playerId)?.wins ?? 0;

  // Scores inside a group of players level on wins, keyed by player.
  const groupScore = (playerId: string, group: ReadonlySet<string>): number => {
    let score = 0;
    for (const position of decided) {
      if (position.winnerPlayerId !== playerId) {
        continue;
      }
      const loser = position.loserPlayerId;
      if (loser !== null && group.has(loser)) {
        score += 1;
      }
    }
    return score;
  };

  const winsGroups = new Map<number, Set<string>>();
  for (const entrant of entrants) {
    const wins = winsOf(entrant.playerId);
    const group = winsGroups.get(wins) ?? new Set<string>();
    group.add(entrant.playerId);
    winsGroups.set(wins, group);
  }

  const ordered = [...entrants].sort((left, right) => {
    const leftWins = winsOf(left.playerId);
    const rightWins = winsOf(right.playerId);
    if (rightWins !== leftWins) {
      return rightWins - leftWins;
    }

    const group = winsGroups.get(leftWins) ?? new Set<string>();
    const leftGroup = groupScore(left.playerId, group);
    const rightGroup = groupScore(right.playerId, group);
    if (rightGroup !== leftGroup) {
      return rightGroup - leftGroup;
    }

    const leftRow = table.get(left.playerId) ?? { forPoints: 0, againstPoints: 0, wins: 0 };
    const rightRow = table.get(right.playerId) ?? { forPoints: 0, againstPoints: 0, wins: 0 };
    const leftDiff = leftRow.forPoints - leftRow.againstPoints;
    const rightDiff = rightRow.forPoints - rightRow.againstPoints;
    if (rightDiff !== leftDiff) {
      return rightDiff - leftDiff;
    }

    return (seedOf.get(left.playerId) ?? 0) - (seedOf.get(right.playerId) ?? 0);
  });

  if (!done) {
    return { done: false, championPlayerId: null, places: [], eliminated: [] };
  }

  const places: FinishPlace[] = ordered.map((entrant, index) => ({
    playerId: entrant.playerId,
    place: index + 1,
    eliminatedRound: null,
  }));

  return {
    done,
    championPlayerId: ordered[0]?.playerId ?? null,
    places,
    eliminated: [],
  };
}

/** The round-robin strategy. */
export const roundRobinFormat: TournamentFormat = {
  kind: "round_robin",
  minPlayers: 3,
  maxPlayers: 8,
  plan,
  // Every pairing is scheduled from the start, so a winner has nowhere to go.
  nextSeat: () => null,
  summarise,
};
