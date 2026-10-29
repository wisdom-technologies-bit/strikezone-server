import { describe, expect, it } from "vitest";
import { formatFor } from "../../src/tournaments/format.js";
import { bracketSize, firstRound, seedOrder } from "../../src/tournaments/seeding.js";
import type { DecidedPosition, FormatEntrant } from "../../src/tournaments/types.js";

/** Every entrant count the server accepts. */
const ALL_COUNTS = Array.from({ length: 63 }, (_unused, index) => index + 2);

function entrantsFor(count: number): FormatEntrant[] {
  return Array.from({ length: count }, (_unused, index) => ({
    playerId: `p${String(index + 1)}`,
    seed: index + 1,
    isBot: false,
  }));
}

/** A decided position, with the winner written into seat 1 unless given. */
function decided(input: {
  round: number;
  slot: number;
  seat1: string;
  seat2: string;
  winner: string;
  seat1Points: number;
  seat2Points: number;
}): DecidedPosition {
  return {
    round: input.round,
    slot: input.slot,
    seat1PlayerId: input.seat1,
    seat2PlayerId: input.seat2,
    winnerPlayerId: input.winner,
    loserPlayerId: input.seat1 === input.winner ? input.seat2 : input.seat1,
    points: { seat1: input.seat1Points, seat2: input.seat2Points },
  };
}

describe("seeding", () => {
  it("lays a full bracket out so the top two seeds can only meet in the final", () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);

    for (const size of [2, 4, 8, 16, 32, 64]) {
      const order = seedOrder(size);

      // Every seed appears exactly once.
      expect([...order].sort((left, right) => left - right)).toEqual(
        Array.from({ length: size }, (_unused, index) => index + 1),
      );

      // Seed 1 and seed 2 sit in opposite halves.
      expect(order[0]).toBe(1);
      expect(order.slice(0, size / 2)).toContain(1);
      expect(order.slice(size / 2)).toContain(2);

      // Each first-round pair sums to size + 1: that is what makes it fair.
      for (let index = 0; index < size; index += 2) {
        expect((order[index] ?? 0) + (order[index + 1] ?? 0)).toBe(size + 1);
      }
    }
  });

  it("gives the byes to the best seeds", () => {
    const five = firstRound(5);
    expect(five.size).toBe(8);
    expect(five.byes).toBe(3);

    const byeSeeds = five.pairs
      .filter((pair) => pair.seat1Seed === null || pair.seat2Seed === null)
      .map((pair) => pair.seat1Seed ?? pair.seat2Seed ?? 0)
      .sort((left, right) => left - right);
    expect(byeSeeds).toEqual([1, 2, 3]);

    // The two players who do have to play are the middle seeds.
    const playing = five.pairs
      .filter((pair) => pair.seat1Seed !== null && pair.seat2Seed !== null)
      .map((pair) => [pair.seat1Seed, pair.seat2Seed]);
    expect(playing).toEqual([[4, 5]]);
  });
});

describe("single elimination brackets", () => {
  const format = formatFor("single_elimination");

  it("generates a valid bracket for every entrant count from 2 to 64", () => {
    for (const count of ALL_COUNTS) {
      const plan = format.plan(count);
      const size = bracketSize(count);

      expect(plan.entrants).toBe(count);
      expect(plan.rounds).toBe(Math.log2(size));
      expect(plan.byes).toBe(size - count);

      const firstRoundPositions = plan.positions.filter((position) => position.round === 1);
      expect(firstRoundPositions).toHaveLength(size / 2);

      const seedsSeated = firstRoundPositions
        .flatMap((position) => [position.seat1Seed, position.seat2Seed])
        .filter((seed): seed is number => seed !== null)
        .sort((left, right) => left - right);

      expect(seedsSeated).toEqual(Array.from({ length: count }, (_unused, index) => index + 1));

      // Every position points at a slot in the next round, except the final.
      for (const position of plan.positions) {
        if (position.round < plan.rounds) {
          const nextRound = plan.positions.filter((other) => other.round === position.round + 1);
          expect(position.winnerToSlot).toBeGreaterThanOrEqual(1);
          expect(position.winnerToSlot).toBeLessThanOrEqual(nextRound.length);
        } else {
          expect(position.winnerToSlot).toBeNull();
        }
      }

      // Each round halves, and the last round is the final.
      for (let round = 1; round <= plan.rounds; round += 1) {
        const inRound = plan.positions.filter((position) => position.round === round);
        expect(inRound).toHaveLength(size / 2 ** round);
        expect(inRound.map((position) => position.slot)).toEqual(
          Array.from({ length: size / 2 ** round }, (_unused, index) => index + 1),
        );
      }
    }
  });

  it("never seats the same seed twice", () => {
    for (const count of ALL_COUNTS) {
      const seeds = format
        .plan(count)
        .positions.flatMap((position) => [position.seat1Seed, position.seat2Seed])
        .filter((seed): seed is number => seed !== null);

      expect(new Set(seeds).size).toBe(seeds.length);
      expect(seeds).toHaveLength(count);
    }
  });

  it("sends a winner to the right seat: odd slots to seat 1, even to seat 2", () => {
    const plan = format.plan(8);
    const slot1 = plan.positions.find((position) => position.round === 1 && position.slot === 1);
    const slot2 = plan.positions.find((position) => position.round === 1 && position.slot === 2);

    expect(format.nextSeat(slot1!)).toEqual({ round: 2, slot: 1, seat: 1 });
    expect(format.nextSeat(slot2!)).toEqual({ round: 2, slot: 1, seat: 2 });

    const final = plan.positions.find((position) => position.round === plan.rounds);
    expect(format.nextSeat(final!)).toBeNull();
  });

  it("orders the finish by how far each player got, then by seed", () => {
    const positions: DecidedPosition[] = [
      decided({
        round: 1,
        slot: 1,
        seat1: "p1",
        seat2: "p4",
        winner: "p1",
        seat1Points: 25,
        seat2Points: 9,
      }),
      decided({
        round: 1,
        slot: 2,
        seat1: "p2",
        seat2: "p3",
        winner: "p2",
        seat1Points: 25,
        seat2Points: 20,
      }),
      decided({
        round: 2,
        slot: 1,
        seat1: "p1",
        seat2: "p2",
        winner: "p1",
        seat1Points: 25,
        seat2Points: 22,
      }),
    ];

    const outcome = format.summarise(format.plan(4), positions, entrantsFor(4));

    expect(outcome.done).toBe(true);
    expect(outcome.championPlayerId).toBe("p1");
    expect(outcome.places).toEqual([
      { playerId: "p1", place: 1, eliminatedRound: null },
      { playerId: "p2", place: 2, eliminatedRound: 2 },
      { playerId: "p3", place: 3, eliminatedRound: 1 },
      { playerId: "p4", place: 4, eliminatedRound: 1 },
    ]);
  });

  it("is not done until the final is decided", () => {
    const positions: DecidedPosition[] = [
      decided({
        round: 1,
        slot: 1,
        seat1: "p1",
        seat2: "p4",
        winner: "p1",
        seat1Points: 25,
        seat2Points: 9,
      }),
    ];

    const outcome = format.summarise(format.plan(4), positions, entrantsFor(4));

    expect(outcome.done).toBe(false);
    expect(outcome.places).toEqual([]);
  });

  it("advances a bye without a match, so a five player bracket is playable", () => {
    const plan = format.plan(5);
    const pairs = plan.positions.filter((position) => position.round === 1);

    // Three of the four first-round positions are a single entrant and a bye.
    const byes = pairs.filter(
      (position) => position.seat1Seed === null || position.seat2Seed === null,
    );
    expect(byes).toHaveLength(3);
    expect(pairs.filter((p) => p.seat1Seed !== null && p.seat2Seed !== null)).toHaveLength(1);
  });
});

describe("round robin schedules", () => {
  const format = formatFor("round_robin");

  it("pairs every entrant with every other exactly once, 3 to 8 players", () => {
    for (const count of [3, 4, 5, 6, 7, 8]) {
      const plan = format.plan(count);
      const pairs = plan.positions.map((position) =>
        [position.seat1Seed, position.seat2Seed].sort(
          (left, right) => Number(left) - Number(right),
        ),
      );

      const expected = (count * (count - 1)) / 2;
      expect(pairs).toHaveLength(expected);
      expect(new Set(pairs.map((pair) => pair.join("-"))).size).toBe(expected);

      for (const [left, right] of pairs) {
        expect(left).not.toBe(right);
        expect(left).toBeGreaterThanOrEqual(1);
        expect(right).toBeLessThanOrEqual(count);
      }

      expect(plan.rounds).toBe(count % 2 === 0 ? count - 1 : count);
      expect(plan.positions.every((position) => position.winnerToSlot === null)).toBe(true);
    }
  });

  it("breaks a three way tie on point difference, never on an arbitrary order", () => {
    const plan = format.plan(4);

    // The circle method gives 1v4, 2v3 / 1v3, 4v2 / 1v2, 3v4.
    // p1, p2 and p3 each win twice and each beat one of the others, so the
    // head-to-head score inside the group is level and point difference decides.
    const positions: DecidedPosition[] = [
      decided({
        round: 1,
        slot: 1,
        seat1: "p1",
        seat2: "p4",
        winner: "p1",
        seat1Points: 25,
        seat2Points: 10,
      }),
      decided({
        round: 1,
        slot: 2,
        seat1: "p2",
        seat2: "p3",
        winner: "p2",
        seat1Points: 25,
        seat2Points: 24,
      }),
      decided({
        round: 2,
        slot: 1,
        seat1: "p1",
        seat2: "p3",
        winner: "p3",
        seat1Points: 23,
        seat2Points: 25,
      }),
      decided({
        round: 2,
        slot: 2,
        seat1: "p4",
        seat2: "p2",
        winner: "p2",
        seat1Points: 5,
        seat2Points: 25,
      }),
      decided({
        round: 3,
        slot: 1,
        seat1: "p1",
        seat2: "p2",
        winner: "p1",
        seat1Points: 25,
        seat2Points: 20,
      }),
      decided({
        round: 3,
        slot: 2,
        seat1: "p3",
        seat2: "p4",
        winner: "p3",
        seat1Points: 25,
        seat2Points: 6,
      }),
    ];

    const outcome = format.summarise(plan, positions, entrantsFor(4));

    expect(outcome.done).toBe(true);
    // Point differences: p3 +20, p1 +18, p2 +16, p4 -54.
    expect(outcome.places.map((place) => place.playerId)).toEqual(["p3", "p1", "p2", "p4"]);
    expect(outcome.championPlayerId).toBe("p3");
  });

  it("settles two players level on wins by their own result, not by points", () => {
    const plan = format.plan(4);

    // p1 and p2 both win twice. p1 has the far better point difference, but p2
    // beat p1, so p2 finishes above. p3 beat p4 and is above p4 for the same reason.
    const positions: DecidedPosition[] = [
      decided({
        round: 1,
        slot: 1,
        seat1: "p1",
        seat2: "p4",
        winner: "p1",
        seat1Points: 25,
        seat2Points: 0,
      }),
      decided({
        round: 1,
        slot: 2,
        seat1: "p2",
        seat2: "p3",
        winner: "p2",
        seat1Points: 25,
        seat2Points: 1,
      }),
      decided({
        round: 2,
        slot: 1,
        seat1: "p1",
        seat2: "p3",
        winner: "p1",
        seat1Points: 25,
        seat2Points: 0,
      }),
      decided({
        round: 2,
        slot: 2,
        seat1: "p4",
        seat2: "p2",
        winner: "p4",
        seat1Points: 25,
        seat2Points: 0,
      }),
      decided({
        round: 3,
        slot: 1,
        seat1: "p1",
        seat2: "p2",
        winner: "p2",
        seat1Points: 0,
        seat2Points: 25,
      }),
      decided({
        round: 3,
        slot: 2,
        seat1: "p3",
        seat2: "p4",
        winner: "p3",
        seat1Points: 25,
        seat2Points: 12,
      }),
    ];

    const outcome = format.summarise(plan, positions, entrantsFor(4));

    // p1 point difference +25, p2 +24, yet p2 is first: head to head first.
    expect(outcome.places.map((place) => place.playerId)).toEqual(["p2", "p1", "p3", "p4"]);
  });

  it("is not done until every pairing has been played", () => {
    const positions: DecidedPosition[] = [
      decided({
        round: 1,
        slot: 1,
        seat1: "p1",
        seat2: "p2",
        winner: "p1",
        seat1Points: 25,
        seat2Points: 1,
      }),
    ];

    const outcome = format.summarise(format.plan(3), positions, entrantsFor(3));

    expect(outcome.done).toBe(false);
    expect(outcome.championPlayerId).toBeNull();
  });
});
