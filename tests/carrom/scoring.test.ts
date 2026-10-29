import { describe, expect, it } from "vitest";
import { applyShot, createInitialState } from "../../src/engines/carrom/index.js";
import { resolveShot } from "../../src/engines/carrom/rules.js";
import { config, outcomeFor, rulesState } from "./helpers.js";

const lastWhiteCoin = { id: "w1", colour: "white" } as const;

describe("board scoring", () => {
  it("scores one point per opposing coin left plus three for the queen", () => {
    const state = rulesState({
      pocketed: { white: 8, black: 2 },
      queen: { onBoard: false, coveredBy: "white" },
    });
    const { state: next, events } = resolveShot(state, outcomeFor(state, [lastWhiteCoin]), config);

    expect(events).toContainEqual({
      type: "board_ended",
      shot: 1,
      winner: "white",
      points: 10,
      opponentCoinsLeft: 7,
      queenPoints: 3,
    });
    expect(next.players.white.score).toBe(10);
    expect(next.board).toBe(2);
  });

  it("awards no queen points when the opponent covered her", () => {
    const state = rulesState({
      pocketed: { white: 8, black: 0 },
      queen: { onBoard: false, coveredBy: "black" },
    });
    const { events } = resolveShot(state, outcomeFor(state, [lastWhiteCoin]), config);

    const ended = events.find((event) => event.type === "board_ended");
    expect(ended).toBeDefined();
    expect(ended?.type === "board_ended" && ended.points).toBe(9);
    expect(ended?.type === "board_ended" && ended.queenPoints).toBe(0);
  });

  it("ends the board with no queen bonus when the queen is still on the board", () => {
    const state = rulesState({
      pocketed: { white: 8, black: 4 },
      queen: { onBoard: true, coveredBy: null },
    });
    const { state: next, events } = resolveShot(state, outcomeFor(state, [lastWhiteCoin]), config);

    const ended = events.find((event) => event.type === "board_ended");
    expect(ended?.type === "board_ended" && ended.points).toBe(5);
    expect(next.board).toBe(2);
  });

  it("starts the next board with fresh coins, clean tallies and the other breaker", () => {
    const state = rulesState({
      pocketed: { white: 8, black: 3 },
      owed: { white: 0, black: 1 },
      queen: { onBoard: false, coveredBy: "white" },
    });
    const { state: next } = resolveShot(state, outcomeFor(state, [lastWhiteCoin]), config);

    expect(next.board).toBe(2);
    expect(next.turn).toBe("black");
    expect(next.coins.length).toBe(19);
    expect(next.players.white).toEqual({ score: 9, pocketed: 0, owed: 0 });
    expect(next.players.black).toEqual({ score: 0, pocketed: 0, owed: 1 - 1 });
    expect(next.queen).toEqual({ onBoard: true, coveredBy: null, pending: null });
    expect(next.phase).toBe("aiming");
  });
});

describe("match end", () => {
  it("ends the match when a player reaches the target score", () => {
    const state = rulesState({
      pocketed: { white: 8, black: 0 },
      scores: { white: 20, black: 8 },
      queen: { onBoard: false, coveredBy: "white" },
    });
    const { state: next, events } = resolveShot(state, outcomeFor(state, [lastWhiteCoin]), config);

    expect(events).toContainEqual({
      type: "match_ended",
      shot: 1,
      winner: "white",
      scores: { white: 32, black: 8 },
    });
    expect(next.phase).toBe("match_ended");
  });

  it("ends the match after the last scheduled board even below the target", () => {
    const state = rulesState({
      board: 8,
      pocketed: { white: 8, black: 8 },
      scores: { white: 3, black: 2 },
      queen: { onBoard: false, coveredBy: "white" },
    });
    const { state: next, events } = resolveShot(state, outcomeFor(state, [lastWhiteCoin]), config);

    expect(events).toContainEqual({
      type: "match_ended",
      shot: 1,
      winner: "white",
      scores: { white: 7, black: 2 },
    });
    expect(next.phase).toBe("match_ended");
  });

  it("reports a tie when the last board leaves the scores level", () => {
    const state = rulesState({
      board: 8,
      pocketed: { white: 8, black: 9 },
      scores: { white: 5, black: 5 },
      queen: { onBoard: false, coveredBy: null },
    });
    const { events } = resolveShot(state, outcomeFor(state, [lastWhiteCoin]), config);

    expect(events).toContainEqual({
      type: "match_ended",
      shot: 1,
      winner: "tie",
      scores: { white: 5, black: 5 },
    });
  });

  it("refuses further shots once the match has ended", () => {
    const ended = { ...rulesState(), phase: "match_ended" as const };
    expect(() =>
      applyShot(ended, { strikerPosition: { x: 0, y: -280 }, angle: 0, power: 0.5 }, { config }),
    ).toThrow(/match has ended/);
  });
});

describe("initial state", () => {
  it("starts with the standard formation and white to break", () => {
    const state = createInitialState(config, "seed-1");
    const white = state.coins.filter((coin) => coin.colour === "white");
    const black = state.coins.filter((coin) => coin.colour === "black");

    expect(state.coins).toHaveLength(19);
    expect(white).toHaveLength(9);
    expect(black).toHaveLength(9);
    expect(state.coins.filter((coin) => coin.colour === "queen")).toHaveLength(1);
    expect(state.turn).toBe("white");
    expect(state.board).toBe(1);
    expect(state.players.white.score).toBe(0);

    const queen = state.coins.find((coin) => coin.colour === "queen");
    expect(queen).toMatchObject({ x: 0, y: 0 });
  });
});
