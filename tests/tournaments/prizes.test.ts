import { describe, expect, it } from "vitest";
import { computePrizes, rakeOf } from "../../src/tournaments/prizes.js";

function players(
  entries: readonly (readonly [string, boolean])[],
): Map<string, { isBot: boolean }> {
  return new Map(entries.map(([playerId, isBot]) => [playerId, { isBot }]));
}

function order(count: number): { playerId: string; place: number }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    playerId: `p${String(index + 1)}`,
    place: index + 1,
  }));
}

describe("the rake", () => {
  it("is basis points of the pool, rounded down", () => {
    expect(rakeOf(8_000, 1_000)).toBe(800);
    expect(rakeOf(1_000, 1_000)).toBe(100);
    expect(rakeOf(999, 1_000)).toBe(99);
    expect(rakeOf(8_000, 0)).toBe(0);
    expect(rakeOf(8_000, 10_000)).toBe(8_000);
  });

  it("refuses a negative pool or an impossible rake", () => {
    expect(() => rakeOf(-1, 1_000)).toThrow();
    expect(() => rakeOf(100, 10_001)).toThrow();
    expect(() => rakeOf(10.5, 1_000)).toThrow();
  });
});

describe("the prize split", () => {
  it("pays 60/30/10 of the post-rake pool for eight players", () => {
    const result = computePrizes({
      poolMinor: 8_000,
      rakeBps: 1_000,
      prizeSplit: [60, 30, 10],
      order: order(8),
      players: players([
        ["p1", false],
        ["p2", false],
        ["p3", false],
      ]),
      botPrizePolicy: "next_human",
    });

    expect(result.rakeMinor).toBe(800);
    expect(result.distributableMinor).toBe(7_200);
    expect(result.payouts).toEqual([
      { playerId: "p1", place: 1, amountMinor: 4_320, viaBotPlayerId: null },
      { playerId: "p2", place: 2, amountMinor: 2_160, viaBotPlayerId: null },
      { playerId: "p3", place: 3, amountMinor: 720, viaBotPlayerId: null },
    ]);
    expect(result.houseMinor).toBe(800);
  });

  it("renormalises the split when fewer than three players finish in the money", () => {
    const result = computePrizes({
      poolMinor: 2_000,
      rakeBps: 1_000,
      prizeSplit: [60, 30, 10],
      order: order(2),
      players: players([
        ["p1", false],
        ["p2", false],
      ]),
      botPrizePolicy: "next_human",
    });

    // 1,800 distributable renormalises 60:30 to 1200:600, with nothing stranded.
    expect(result.payouts.map((payout) => payout.amountMinor)).toEqual([1_200, 600]);
    expect(result.houseMinor).toBe(200);
  });

  it("gives the rounding remainder to first place", () => {
    const result = computePrizes({
      poolMinor: 1_001,
      rakeBps: 0,
      prizeSplit: [60, 30, 10],
      order: order(3),
      players: players([
        ["p1", false],
        ["p2", false],
        ["p3", false],
      ]),
      botPrizePolicy: "next_human",
    });

    expect(result.payouts.map((payout) => payout.amountMinor)).toEqual([601, 300, 100]);
    expect(result.houseMinor).toBe(0);
  });

  it("passes a bot's prize to the best human below it", () => {
    const result = computePrizes({
      poolMinor: 8_000,
      rakeBps: 1_000,
      prizeSplit: [60, 30, 10],
      order: order(8),
      // A bot wins the whole thing; the humans are second and third.
      players: players([
        ["p1", true],
        ["p2", false],
        ["p3", false],
      ]),
      botPrizePolicy: "next_human",
    });

    expect(result.payouts).toEqual([
      // The bot's own prize, passed to the best-placed human below it, comes
      // first because that is the place it was won at.
      { playerId: "p2", place: 1, amountMinor: 4_320, viaBotPlayerId: "p1" },
      { playerId: "p2", place: 2, amountMinor: 2_160, viaBotPlayerId: null },
      { playerId: "p3", place: 3, amountMinor: 720, viaBotPlayerId: null },
    ]);
    expect(result.houseMinor).toBe(800);
  });

  it("keeps a bot's prize with the house when the policy says so", () => {
    const result = computePrizes({
      poolMinor: 8_000,
      rakeBps: 1_000,
      prizeSplit: [60, 30, 10],
      order: order(8),
      players: players([
        ["p1", true],
        ["p2", false],
        ["p3", false],
      ]),
      botPrizePolicy: "house_keeps",
    });

    expect(result.payouts).toHaveLength(2);
    expect(result.houseMinor).toBe(800 + 4_320);
  });

  it("passes a bot prize below the paid places to the best human left", () => {
    const result = computePrizes({
      poolMinor: 8_000,
      rakeBps: 1_000,
      prizeSplit: [60, 30, 10],
      order: order(8),
      players: players([
        ["p1", true],
        ["p2", true],
        ["p3", true],
        ["p4", false],
      ]),
      botPrizePolicy: "next_human",
    });

    // Three bots take the paid places. Each prize passes to the best human
    // below it, which is p4 in every case, even though p4 finished fourth and
    // the split only pays three places.
    expect(result.payouts).toEqual([
      { playerId: "p4", place: 1, amountMinor: 4_320, viaBotPlayerId: "p1" },
      { playerId: "p4", place: 2, amountMinor: 2_160, viaBotPlayerId: "p2" },
      { playerId: "p4", place: 3, amountMinor: 720, viaBotPlayerId: "p3" },
    ]);
    expect(result.houseMinor).toBe(800);
  });

  it("keeps the money with the house when every entrant is a bot", () => {
    const result = computePrizes({
      poolMinor: 8_000,
      rakeBps: 1_000,
      prizeSplit: [60, 30, 10],
      order: order(8),
      players: players(order(8).map((entry) => [entry.playerId, true] as const)),
      botPrizePolicy: "next_human",
    });

    // Nobody human to pass to, so the whole pool stays with the house.
    expect(result.payouts).toEqual([]);
    expect(result.houseMinor).toBe(8_000);
  });

  it("always balances: payouts plus house is exactly the pool", () => {
    const cases = [
      { pool: 0, players: 2 },
      { pool: 1, players: 2 },
      { pool: 7, players: 3 },
      { pool: 9_999, players: 8 },
      { pool: 100_000, players: 5 },
    ];

    for (const testCase of cases) {
      for (const policy of ["next_human", "house_keeps"] as const) {
        const result = computePrizes({
          poolMinor: testCase.pool,
          rakeBps: 1_000,
          prizeSplit: [60, 30, 10],
          order: order(testCase.players),
          players: players([
            ["p1", true],
            ["p2", false],
            ["p3", false],
          ]),
          botPrizePolicy: policy,
        });

        const paid = result.payouts.reduce((sum, payout) => sum + payout.amountMinor, 0);
        expect(paid + result.houseMinor).toBe(testCase.pool);
      }
    }
  });
});
