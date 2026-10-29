import { describe, expect, it } from "vitest";
import { resolveShot } from "../../src/engines/carrom/rules.js";
import { config, hasCoin, outcomeFor, rulesState } from "./helpers.js";

const queenDrop = { id: "queen", colour: "queen" } as const;
const ownDrop = { id: "w1", colour: "white" } as const;
const blackDrop = { id: "b1", colour: "black" } as const;

describe("turn and pocketing", () => {
  it("keeps the turn and credits one coin after pocketing your own coin", () => {
    const state = rulesState();
    const { state: next, events } = resolveShot(state, outcomeFor(state, [ownDrop]), config);

    expect(next.players.white.pocketed).toBe(1);
    expect(next.turn).toBe("white");
    expect(next.shot).toBe(1);
    expect(events).toContainEqual({
      type: "coin_pocketed",
      shot: 1,
      coin: "white",
      creditedTo: "white",
      by: "white",
      coinId: "w1",
    });
    expect(events.some((event) => event.type === "turn_changed")).toBe(false);
  });

  it("passes the turn when nothing is pocketed", () => {
    const state = rulesState();
    const { state: next, events } = resolveShot(state, outcomeFor(state, []), config);

    expect(next.turn).toBe("black");
    expect(next.players.white.pocketed).toBe(0);
    expect(events).toContainEqual({ type: "turn_changed", shot: 1, from: "white", to: "black" });
  });

  it("does not mutate the state it was given", () => {
    const state = rulesState();
    const before = JSON.stringify(state);
    resolveShot(state, outcomeFor(state, [ownDrop]), config);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("the queen", () => {
  it("returns to the centre when pocketed before any own coin", () => {
    const state = rulesState();
    const { state: next, events } = resolveShot(state, outcomeFor(state, [queenDrop]), config);

    expect(events).toContainEqual({ type: "queen_returned", shot: 1, reason: "no_own_coin" });
    expect(next.queen.onBoard).toBe(true);
    expect(next.queen.pending).toBeNull();
    expect(hasCoin(next, "queen")).toBe(true);
    expect(next.turn).toBe("black");
  });

  it("grants an extra stroke to cover her", () => {
    const state = rulesState({ pocketed: { white: 1 } });
    const { state: next, events } = resolveShot(state, outcomeFor(state, [queenDrop]), config);

    expect(events).toContainEqual({ type: "queen_pocketed", shot: 1, by: "white" });
    expect(next.queen.pending).toBe("white");
    expect(next.queen.coveredBy).toBeNull();
    expect(next.queen.onBoard).toBe(false);
    expect(next.turn).toBe("white");
  });

  it("is covered by an own coin on the covering stroke", () => {
    const pending = rulesState({
      pocketed: { white: 1 },
      queen: { onBoard: false, pending: "white" },
    });
    const { state: next, events } = resolveShot(pending, outcomeFor(pending, [ownDrop]), config);

    expect(events).toContainEqual({ type: "queen_covered", shot: 1, by: "white" });
    expect(next.queen.coveredBy).toBe("white");
    expect(next.queen.pending).toBeNull();
    expect(next.turn).toBe("white");
  });

  it("is covered in the same stroke as an own coin", () => {
    const state = rulesState({ pocketed: { white: 1 } });
    const own = { id: "w2", colour: "white" } as const;
    const { state: next, events } = resolveShot(state, outcomeFor(state, [queenDrop, own]), config);

    expect(events.some((event) => event.type === "queen_pocketed")).toBe(true);
    expect(events).toContainEqual({ type: "queen_covered", shot: 1, by: "white" });
    expect(next.queen.coveredBy).toBe("white");
    expect(next.queen.pending).toBeNull();
  });

  it("returns to the centre when the covering stroke misses", () => {
    const pending = rulesState({
      pocketed: { white: 1 },
      queen: { onBoard: false, pending: "white" },
    });
    const { state: next, events } = resolveShot(pending, outcomeFor(pending, []), config);

    expect(events).toContainEqual({ type: "queen_returned", shot: 1, reason: "not_covered" });
    expect(next.queen.onBoard).toBe(true);
    expect(next.queen.pending).toBeNull();
    expect(hasCoin(next, "queen")).toBe(true);
    expect(next.turn).toBe("black");
  });

  it("returns to the centre when the covering stroke fouled", () => {
    const pending = rulesState({
      pocketed: { white: 1 },
      queen: { onBoard: false, pending: "white" },
    });
    const { events } = resolveShot(
      pending,
      outcomeFor(pending, [], { strikerPocketed: true }),
      config,
    );

    expect(events).toContainEqual({ type: "queen_returned", shot: 1, reason: "foul" });
  });
});

describe("fouls", () => {
  it("charges a pocketed coin back to the centre when the striker drops", () => {
    const state = rulesState({ pocketed: { white: 2 } });
    const { state: next, events } = resolveShot(
      state,
      outcomeFor(state, [], { strikerPocketed: true }),
      config,
    );

    expect(events).toContainEqual({
      type: "foul",
      shot: 1,
      by: "white",
      reason: "striker_pocketed",
    });
    expect(next.players.white.pocketed).toBe(1);
    expect(next.turn).toBe("black");
    expect(next.coins.length).toBe(state.coins.length + 1);
  });

  it("records a debt when there is no pocketed coin to give back", () => {
    const state = rulesState({ pocketed: { white: 0 } });
    const { state: next } = resolveShot(
      state,
      outcomeFor(state, [], { strikerPocketed: true }),
      config,
    );

    expect(next.players.white.owed).toBe(1);
    expect(next.players.white.pocketed).toBe(0);
    expect(next.turn).toBe("black");
  });

  it("credits the opponent when their coin is pocketed, and still charges the fouler", () => {
    const state = rulesState({ pocketed: { white: 1, black: 0 } });
    const { state: next, events } = resolveShot(state, outcomeFor(state, [blackDrop]), config);

    expect(events).toContainEqual({
      type: "foul",
      shot: 1,
      by: "white",
      reason: "opponent_coin_pocketed",
    });
    expect(events).toContainEqual({
      type: "coin_pocketed",
      shot: 1,
      coin: "black",
      creditedTo: "black",
      by: "white",
      coinId: "b1",
    });
    expect(next.players.black.pocketed).toBe(1);
    expect(next.players.white.pocketed).toBe(0);
    expect(next.turn).toBe("black");
  });

  it("cancels the coins pocketed on the fouling stroke", () => {
    const state = rulesState({ pocketed: { white: 3 } });
    const { state: next } = resolveShot(
      state,
      outcomeFor(state, [ownDrop], { strikerPocketed: true }),
      config,
    );

    expect(next.players.white.pocketed).toBe(2);
    expect(hasCoin(next, "white")).toBe(true);
    expect(next.coins.some((coin) => coin.id === "w1")).toBe(true);
  });

  it("settles a debt with the next own coin pocketed", () => {
    const state = rulesState({ pocketed: { white: 2 }, owed: { white: 1 } });
    const drop = { id: "w3", colour: "white" } as const;
    const { state: next } = resolveShot(state, outcomeFor(state, [drop]), config);

    expect(next.players.white.owed).toBe(0);
    expect(next.players.white.pocketed).toBe(2);
    expect(next.coins.some((coin) => coin.id === "w3")).toBe(true);
    expect(next.turn).toBe("white");
  });
});
