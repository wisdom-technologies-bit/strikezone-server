import { describe, expect, it } from "vitest";
import {
  applyShot,
  createInitialState,
  findLegalStrikerX,
  getLegalStrikerRange,
  resolveConfig,
  type CarromCoin,
  type CarromShot,
  type CarromState,
} from "../../src/engines/carrom/index.js";
import { createSeededRng } from "../../src/lib/fair-rng.js";
import { config } from "./helpers.js";

const tolerance = config.overlapToleranceMm + 0.001;

function expectValidBoard(state: CarromState, settings = config): void {
  const coinRadius = settings.coinDiameterMm / 2;
  const limit = settings.boardSizeMm / 2 - coinRadius + 0.01;

  for (const coin of state.coins) {
    expect(Math.abs(coin.x)).toBeLessThanOrEqual(limit);
    expect(Math.abs(coin.y)).toBeLessThanOrEqual(limit);
    expect(Number.isFinite(coin.x)).toBe(true);
    expect(Number.isFinite(coin.y)).toBe(true);
  }

  for (let first = 0; first < state.coins.length; first += 1) {
    for (let second = first + 1; second < state.coins.length; second += 1) {
      const a = state.coins[first];
      const b = state.coins[second];
      if (a === undefined || b === undefined) {
        continue;
      }
      const gap = Math.hypot(b.x - a.x, b.y - a.y);
      expect(gap).toBeGreaterThanOrEqual(2 * coinRadius - tolerance);
    }
  }
}

function randomLegalShot(state: CarromState, rng: ReturnType<typeof createSeededRng>): CarromShot {
  const range = getLegalStrikerRange(state, config);
  const target = rng.pick(state.coins);
  const preferred = Math.min(range.maxX, Math.max(range.minX, target.x));
  const x = findLegalStrikerX(state, preferred, config);
  if (x === null) {
    throw new Error("no legal striker position");
  }
  return {
    strikerPosition: { x, y: range.y },
    angle: Math.atan2(target.y - range.y, target.x - x),
    power: 0.4 + rng.nextFloat() * 0.6,
  };
}

describe("board invariants", () => {
  it("never leaves a coin off the board or overlapping another", () => {
    const rng = createSeededRng("physics-invariants");
    let state = createInitialState(config, "physics-invariants");
    expectValidBoard(state);

    for (let index = 0; index < 14; index += 1) {
      const result = applyShot(state, randomLegalShot(state, rng), { config });
      state = result.state;
      expectValidBoard(state);
    }
  });

  it("keeps coins apart after a full-power break", () => {
    const state = createInitialState(config, "break");
    const range = getLegalStrikerRange(state, config);
    const result = applyShot(
      state,
      { strikerPosition: { x: 0, y: range.y }, angle: Math.PI / 2, power: 1 },
      { config },
    );

    expectValidBoard(result.state);
    expect(result.state.coins.length).toBeLessThanOrEqual(19);
  });
});

describe("pocketing", () => {
  it("pockets a coin from a straight shot next to a pocket", () => {
    // A shorter baseline offset puts the striker behind the coin, which sits in
    // front of the bottom-left pocket.
    const settings = resolveConfig({ baselineOffsetMm: 200 });
    const base = createInitialState(settings, "pocket-seed");
    const coin: CarromCoin = { id: "w1", colour: "white", x: -300, y: -280 };
    const state: CarromState = {
      ...base,
      coins: [coin],
      queen: { onBoard: false, coveredBy: null, pending: null },
    };

    const range = getLegalStrikerRange(state, settings);
    expect(range.y).toBe(-170);

    const shot: CarromShot = {
      strikerPosition: { x: -250, y: range.y },
      angle: Math.atan2(coin.y - range.y, coin.x + 250),
      // Hard enough to reach the coin, soft enough that the striker does not
      // follow it into the pocket (which would be a foul, not a pocket).
      power: 0.2,
    };

    const result = applyShot(state, shot, { config: settings });

    expect(result.events).toContainEqual({
      type: "coin_pocketed",
      shot: 1,
      coin: "white",
      creditedTo: "white",
      by: "white",
      coinId: "w1",
    });
    expect(result.state.coins).toHaveLength(0);
    expect(result.state.players.white.pocketed).toBe(1);
  });

  it("records spectator frames at the configured rate", () => {
    const state = createInitialState(config, "frames");
    const range = getLegalStrikerRange(state, config);
    const result = applyShot(
      state,
      { strikerPosition: { x: 0, y: range.y }, angle: Math.PI / 2, power: 0.9 },
      { config, recordFrames: true },
    );

    const frames = result.frames;
    expect(frames).not.toBeNull();
    expect(frames?.fps).toBe(config.framesPerSecond);
    expect(frames?.frames.length ?? 0).toBeGreaterThan(4);
    expect(frames?.frames[0]?.t).toBe(0);

    const times = (frames?.frames ?? []).map((frame) => frame.t);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThan(times[index - 1] ?? -1);
    }
    expect(frames?.frames[0]?.bodies.some((body) => body.id === "striker")).toBe(true);
  });

  it("omits frames when they are not requested", () => {
    const state = createInitialState(config, "no-frames");
    const range = getLegalStrikerRange(state, config);
    const result = applyShot(
      state,
      { strikerPosition: { x: 0, y: range.y }, angle: 1, power: 0.5 },
      {
        config,
      },
    );

    expect(result.frames).toBeNull();
  });
});

describe("shot validation", () => {
  it("rejects a striker outside the baseline", () => {
    const state = createInitialState(config, "validation");
    const range = getLegalStrikerRange(state, config);

    expect(() =>
      applyShot(
        state,
        { strikerPosition: { x: range.maxX + 5, y: range.y }, angle: 0, power: 0.5 },
        { config },
      ),
    ).toThrow(/illegal striker placement/);
  });

  it("rejects a striker on the wrong baseline", () => {
    const state = createInitialState(config, "validation");
    const range = getLegalStrikerRange(state, config);

    expect(() =>
      applyShot(
        state,
        { strikerPosition: { x: 0, y: -range.y }, angle: 0, power: 0.5 },
        { config },
      ),
    ).toThrow(/illegal striker placement/);
  });

  it("rejects a striker placed on top of a coin", () => {
    const base = createInitialState(config, "validation");
    const range = getLegalStrikerRange(base, config);
    const blocking: CarromCoin = { id: "w1", colour: "white", x: 0, y: range.y };
    const state: CarromState = { ...base, coins: [blocking] };

    expect(() =>
      applyShot(
        state,
        { strikerPosition: { x: blocking.x, y: range.y }, angle: 0, power: 0.5 },
        { config },
      ),
    ).toThrow(/illegal striker placement/);
  });

  it("rejects a malformed shot", () => {
    const state = createInitialState(config, "validation");
    const range = getLegalStrikerRange(state, config);

    expect(() =>
      applyShot(state, { strikerPosition: { x: 0, y: range.y }, angle: 0, power: 1.5 }, { config }),
    ).toThrow();
    expect(() =>
      applyShot(
        state,
        // Unknown field, which the zod schema rejects.
        { strikerPosition: { x: 0, y: range.y }, angle: 0, power: 0.5, spin: 1 } as never,
        { config },
      ),
    ).toThrow();
  });
});
