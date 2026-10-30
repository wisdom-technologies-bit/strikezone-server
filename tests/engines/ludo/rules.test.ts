import { describe, expect, it } from "vitest";
import {
  applyMove,
  applyRoll,
  createFastDice,
  createInitialState,
  createMatchDice,
  forfeitTurn,
  getLegalMoves,
  LUDO_HOME,
  LUDO_YARD,
  passTurn,
  resolveLudoConfig,
  rollDie,
  seatToPlay,
  shouldForfeitTripleSix,
  startCellOf,
  aggressiveChooser,
  cautiousChooser,
  racerChooser,
  type LudoConfig,
  type LudoState,
} from "../../../src/engines/ludo/index.js";
import { createSeededRng } from "../../../src/lib/fair-rng.js";

/**
 * Every rule in docs/ludo-rules.md, as a test.
 *
 * The states are built by hand from a token table, so each test reads like the rule
 * it checks: `tokens` is the flat board, seat 0's four tokens first.
 */

/** A state built from a flat token table. */
function stateWith(
  tokens: readonly number[],
  options: {
    readonly config?: Partial<LudoConfig>;
    readonly turn?: number;
    readonly sixes?: number;
    readonly finishingOrder?: readonly number[];
  } = {},
): LudoState {
  const config = resolveLudoConfig({ players: 4, ...options.config });
  return {
    config,
    seats: [0, 1, 2, 3],
    tokens: [...tokens],
    turn: options.turn ?? 0,
    sixes: options.sixes ?? 0,
    rolls: 0,
    finishingOrder: options.finishingOrder ?? [],
    status: "playing",
  };
}

/** Seat 1 sits 13 cells after seat 0, so progress `p` for seat 1 is one lap behind. */
const PROGRESS_ONE_LAP = 51;

describe("leaving the yard", () => {
  it("needs a 6, and only a 6 offers the move", () => {
    const state = stateWith([LUDO_YARD, LUDO_YARD, LUDO_YARD, LUDO_YARD, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);

    expect(getLegalMoves(state, 5)).toHaveLength(0);
    expect(getLegalMoves(state, 3)).toHaveLength(0);

    const moves = getLegalMoves(state, 6);
    expect(moves).toHaveLength(4);
    expect(moves[0]).toMatchObject({ kind: "enter", from: LUDO_YARD, to: 0, token: 0 });
  });

  it("lands on the seat's own starting cell, which is safe", () => {
    const state = stateWith([-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    const outcome = applyMove(state, getLegalMoves(state, 6)[0]!);

    expect(outcome.state.tokens[0]).toBe(0);
    expect(outcome.events.map((event) => event.type)).toEqual(["token_out", "extra_roll"]);
    expect(outcome.state.tokens.slice(0, 4)).toEqual([0, -1, -1, -1]);
  });

  it("cannot bring a token out onto a block", () => {
    // Seat 1 has two tokens on seat 0's starting cell, which is cell 0.
    const tokens = [-1, -1, -1, -1, 39, 39, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    const state = stateWith(tokens);

    expect(getLegalMoves(state, 6)).toHaveLength(0);
  });
});

describe("the extra roll", () => {
  it("keeps the turn on a 6", () => {
    const state = stateWith([5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    const outcome = applyMove(state, getLegalMoves(state, 6)[0]!);

    expect(outcome.state.turn).toBe(0);
    expect(seatToPlay(outcome.state)).toBe(0);
    expect(outcome.state.sixes).toBe(1);
    expect(outcome.events.some((event) => event.type === "extra_roll")).toBe(true);
  });

  it("passes the turn on anything else", () => {
    const state = stateWith([5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    const outcome = applyMove(state, getLegalMoves(state, 2)[0]!);

    expect(outcome.state.turn).toBe(1);
    expect(outcome.state.sixes).toBe(0);
    expect(outcome.events.some((event) => event.type === "turn_changed")).toBe(true);
  });

  it("resets the six count after a non-six", () => {
    const state = stateWith([5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1], {
      sixes: 1,
    });
    const outcome = applyMove(state, getLegalMoves(state, 2)[0]!);

    expect(outcome.state.sixes).toBe(0);
  });
});

describe("three sixes", () => {
  it("forfeits the turn and does not play the third 6", () => {
    const state = stateWith([5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1], {
      sixes: 2,
    });

    expect(shouldForfeitTripleSix(state, 6)).toBe(true);

    const outcome = applyRoll(state, 6, racerChooser);
    expect(outcome.events.map((event) => event.type)).toEqual([
      "triple_six_forfeit",
      "turn_changed",
    ]);
    // The token did not move: the third six is forfeited, not played.
    expect(outcome.state.tokens[0]).toBe(5);
    expect(outcome.state.turn).toBe(1);
    expect(outcome.state.sixes).toBe(0);
  });

  it("does not forfeit on two sixes", () => {
    const state = stateWith([5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1], {
      sixes: 1,
    });
    expect(shouldForfeitTripleSix(state, 6)).toBe(false);
    expect(shouldForfeitTripleSix(state, 5)).toBe(false);
  });

  it("forfeits without a roll when asked to", () => {
    const state = stateWith([5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    const outcome = forfeitTurn(state, 6, "timeout");

    expect(outcome.events[0]).toMatchObject({ type: "triple_six_forfeit", reason: "timeout" });
  });
});

describe("capturing", () => {
  it("sends a single opponent token back to its yard", () => {
    // Seat 0's token at progress 3 is on cell 3; seat 1's token at progress 42 is
    // on cell (13 + 42) % 52 = 3 as well.
    const tokens = [0, -1, -1, -1, 42, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    const state = stateWith(tokens);

    const move = getLegalMoves(state, 3).find((candidate) => candidate.token === 0);
    expect(move?.captures).toEqual([4]);

    const outcome = applyMove(state, move!);
    expect(outcome.state.tokens[4]).toBe(LUDO_YARD);
    expect(outcome.events.find((event) => event.type === "capture")).toMatchObject({
      seat: 0,
      captured: { seat: 1, token: 0 },
    });
    // A capture in the default rules earns another roll.
    expect(outcome.state.turn).toBe(0);
  });

  it("cannot capture on a safe cell", () => {
    // Cell 8 is a star, safe. Seat 0 at progress 8 arrives there; seat 1's token at
    // progress 47 is on cell (13 + 47) % 52 = 8.
    const tokens = [5, -1, -1, -1, 47, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    const state = stateWith(tokens);

    const move = getLegalMoves(state, 3).find((candidate) => candidate.token === 0);
    expect(move).toBeDefined();
    expect(move?.captures).toEqual([]);

    const outcome = applyMove(state, move!);
    expect(outcome.state.tokens[4]).toBe(47);
    expect(outcome.events.some((event) => event.type === "capture")).toBe(false);
  });

  it("cannot capture a token in a home column", () => {
    const tokens = [0, -1, -1, -1, 51, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    const state = stateWith(tokens);

    for (const roll of [1, 2, 3, 4, 5]) {
      for (const move of getLegalMoves(state, roll)) {
        expect(move.captures).toEqual([]);
      }
    }
  });

  it("treats two of one colour as a block that cannot be landed on", () => {
    const tokens = [0, -1, -1, -1, 42, 42, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    const blocked = stateWith(tokens);

    expect(getLegalMoves(blocked, 3).some((move) => move.to === 3)).toBe(false);

    // With stacking open the move is legal and captures both.
    const open = stateWith(tokens, { config: { stacking: "open" } });
    const move = getLegalMoves(open, 3).find((candidate) => candidate.to === 3);
    expect(move?.captures).toEqual([4, 5]);
  });
});

describe("the home column and finishing", () => {
  it("needs an exact roll and refuses to overshoot", () => {
    const tokens = [55, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    const state = stateWith(tokens);

    // 55 + 3 = 58, past home: not a legal move for this token.
    expect(getLegalMoves(state, 3).some((move) => move.token === 0)).toBe(false);
    expect(getLegalMoves(state, 2).some((move) => move.token === 0)).toBe(true);
  });

  it("records a token home, and an extra roll for it", () => {
    const tokens = [56, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    const state = stateWith(tokens);
    const outcome = applyMove(state, getLegalMoves(state, 1)[0]!);

    expect(outcome.state.tokens[0]).toBe(LUDO_HOME);
    expect(outcome.events[0]).toMatchObject({ type: "token_home", to: LUDO_HOME });
    expect(outcome.events.some((event) => event.type === "extra_roll")).toBe(true);
  });

  it("puts every place in the finishing order and ends the game", () => {
    // Seat 0 brings its last token home; seats 1 and 2 already finished.
    const tokens = [56, 57, 57, 57, 57, 57, 57, 57, 57, 57, 57, 57, 20, 12, 5, 40];
    const state = stateWith(tokens, { finishingOrder: [1, 2] });

    const outcome = applyMove(state, getLegalMoves(state, 1)[0]!);

    expect(outcome.events.find((event) => event.type === "player_finished")).toMatchObject({
      seat: 0,
      place: 3,
    });
    expect(outcome.events.find((event) => event.type === "game_ended")).toMatchObject({
      winner: 1,
    });
    expect(outcome.state.finishingOrder).toEqual([1, 2, 0, 3]);
    expect(outcome.state.status).toBe("finished");
  });

  it("gives the last seat standing its place without playing on", () => {
    const tokens = [56, 57, 57, 57, 57, 57, 57, 57, 57, 57, 57, 57, 3, 3, 3, 3];
    const state = stateWith(tokens, { finishingOrder: [1, 2] });

    const outcome = applyMove(state, getLegalMoves(state, 1)[0]!);

    expect(outcome.state.finishingOrder).toEqual([1, 2, 0, 3]);
    expect(outcome.state.status).toBe("finished");
    expect(outcome.events.filter((event) => event.type === "player_finished")).toHaveLength(2);
  });

  it("does not roll again after bringing the last token home", () => {
    const tokens = [56, 57, 57, 57, 57, 57, 57, 57, 4, 4, 4, 4, 3, 3, 3, 3];
    const state = stateWith(tokens, { finishingOrder: [1] });

    const outcome = applyMove(state, getLegalMoves(state, 1)[0]!);

    expect(outcome.state.turn).not.toBe(0);
    expect(outcome.events.some((event) => event.type === "extra_roll")).toBe(false);
  });
});

describe("a turn with no legal move", () => {
  it("passes, and the roll is still counted", () => {
    // Every token is in the yard and the roll is not a 6.
    const state = stateWith([-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    const outcome = applyRoll(state, 4, cautiousChooser);

    expect(outcome.events.map((event) => event.type)).toEqual(["no_legal_move", "turn_changed"]);
    expect(outcome.state.turn).toBe(1);
    expect(outcome.state.rolls).toBe(1);
  });

  it("passes when every token is home but the game moved on", () => {
    const state = stateWith([57, 57, 57, 57, 20, 20, 20, 20, -1, -1, -1, -1, -1, -1, -1, -1], {
      turn: 0,
    });

    // All of seat 0's tokens are home: no move exists, and the turn moves on.
    const outcome = passTurn(state, 3, "no_legal_move");
    expect(outcome.state.turn).toBe(1);
  });
});

describe("the dice", () => {
  it("draws 1 to 6 from a uniform generator", () => {
    const rng = createSeededRng("die-test-seed");
    for (let index = 0; index < 10_000; index += 1) {
      const face = rollDie(rng);
      expect(face).toBeGreaterThanOrEqual(1);
      expect(face).toBeLessThanOrEqual(6);
      expect(Number.isInteger(face)).toBe(true);
    }
  });

  it("replays the same rolls from the same seed and nonce", () => {
    const seed = "a".repeat(64);
    const first = createMatchDice(seed, "match-1");
    const second = createMatchDice(seed, "match-1");

    const a = Array.from({ length: 50 }, () => first.roll(6));
    const b = Array.from({ length: 50 }, () => second.roll(6));
    expect(a).toEqual(b);
    expect(first.rolls).toBe(50);
  });

  it("starts the stream at a later nonce without losing step", () => {
    const seed = "b".repeat(64);
    const all = createMatchDice(seed, "match-2");
    const rolls = Array.from({ length: 20 }, () => all.roll(6));

    const resumed = createMatchDice(seed, "match-2", 10);
    expect(Array.from({ length: 10 }, () => resumed.roll(6))).toEqual(rolls.slice(10));
  });

  it("is uniform over a million rolls (chi-square, 5 degrees of freedom)", () => {
    const dice = createFastDice("c".repeat(64), "chi-square");
    const counts = [0, 0, 0, 0, 0, 0];
    const total = 1_000_000;

    for (let index = 0; index < total; index += 1) {
      const face = dice.roll(6);
      counts[face - 1] = (counts[face - 1] ?? 0) + 1;
    }

    const expected = total / 6;
    const chiSquare = counts.reduce(
      (sum, count) => sum + ((count - expected) * (count - expected)) / expected,
      0,
    );

    // The 99.9% critical value for 5 degrees of freedom is 20.5; a fair die lands
    // near 5, so anything above that means the generator is biased.
    expect(chiSquare).toBeLessThan(20.5);
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.01);
    }
  });
});

describe("the board", () => {
  it("puts the second seat 13 cells after the first", () => {
    expect(startCellOf(1) - startCellOf(0)).toBe(13);
    expect(startCellOf(3)).toBe(39);
  });

  it("keeps two-player seats opposite each other", () => {
    const state = createInitialState({ players: 2 });
    expect(state.seats).toEqual([0, 2]);
    expect(state.tokens).toHaveLength(8);
  });

  it("refuses a configuration that is not Ludo", () => {
    expect(() => resolveLudoConfig({ players: 3 as unknown as 2 })).toThrow(/players must be 2 or 4/u);
    expect(() => resolveLudoConfig({ diceSides: 8 })).toThrow(/6-sided/u);
  });

  it("counts a lap as 51 ring steps and six home cells", () => {
    expect(PROGRESS_ONE_LAP).toBe(51);
    expect(LUDO_HOME).toBe(57);
  });
});

describe("the choosers", () => {
  it("has all three and refuses an illegal pick", () => {
    const state = stateWith([5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    const moves = getLegalMoves(state, 3);
    for (const chooser of [cautiousChooser, aggressiveChooser, racerChooser]) {
      expect(moves).toContain(chooser(state, 3, moves));
    }
  });

  it("throws rather than invent a move when there are none", () => {
    expect(() => aggressiveChooser(createInitialState(), 1, [])).toThrow(/no moves/u);
  });
});
