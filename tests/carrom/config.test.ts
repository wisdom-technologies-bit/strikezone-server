import { describe, expect, it } from "vitest";
import {
  DEFAULT_CARROM_CONFIG,
  createInitialState,
  findLegalStrikerX,
  getLegalStrikerRange,
  isLegalStrikerPlacement,
  resolveConfig,
  type CarromCoin,
  type CarromState,
} from "../../src/engines/carrom/index.js";
import { config } from "./helpers.js";

describe("resolveConfig", () => {
  it("applies overrides on top of the defaults", () => {
    const tuned = resolveConfig({ coinDiameterMm: 32, pointsToWinMatch: 29 });

    expect(tuned.coinDiameterMm).toBe(32);
    expect(tuned.pointsToWinMatch).toBe(29);
    expect(tuned.boardSizeMm).toBe(DEFAULT_CARROM_CONFIG.boardSizeMm);
  });

  it("refuses values that cannot work", () => {
    expect(() => resolveConfig({ coinDiameterMm: 0 })).toThrow(RangeError);
    expect(() => resolveConfig({ coinMassG: -1 })).toThrow(RangeError);
    expect(() => resolveConfig({ wallRestitution: 1 })).toThrow(RangeError);
    expect(() => resolveConfig({ coinRestitution: -0.1 })).toThrow(RangeError);
    expect(() => resolveConfig({ boardsPerMatch: 0 })).toThrow(RangeError);
    expect(() => resolveConfig({ boardsPerMatch: 2.5 })).toThrow(RangeError);
    expect(() => resolveConfig({ baselineEndInsetMm: 400 })).toThrow(RangeError);
    expect(() => resolveConfig({ baselineOffsetMm: 400 })).toThrow(RangeError);
    expect(() => resolveConfig({ coinDiameterMm: 800 })).toThrow(RangeError);
  });

  it("keeps the defaults frozen", () => {
    expect(Object.isFrozen(DEFAULT_CARROM_CONFIG)).toBe(true);
  });
});

describe("baselines and placement", () => {
  it("mirrors the baseline for the second player", () => {
    const white = createInitialState(config, "baselines");
    const black: CarromState = { ...white, turn: "black" };

    const whiteRange = getLegalStrikerRange(white, config);
    const blackRange = getLegalStrikerRange(black, config);

    expect(whiteRange.side).toBe("bottom");
    expect(whiteRange.y).toBeLessThan(0);
    expect(blackRange.side).toBe("top");
    expect(blackRange.y).toBe(-whiteRange.y);
    expect(blackRange.minX).toBe(whiteRange.minX);
    expect(blackRange.maxX).toBe(whiteRange.maxX);
  });

  it("accepts a legal position and rejects one past the end of the baseline", () => {
    const state = createInitialState(config, "placement");
    const range = getLegalStrikerRange(state, config);

    expect(isLegalStrikerPlacement(state, { x: range.minX, y: range.y }, config)).toBe(true);
    expect(isLegalStrikerPlacement(state, { x: range.maxX, y: range.y }, config)).toBe(true);
    expect(isLegalStrikerPlacement(state, { x: range.maxX + 1, y: range.y }, config)).toBe(false);
    expect(isLegalStrikerPlacement(state, { x: 0, y: 0 }, config)).toBe(false);
  });

  it("moves a blocked striker to the nearest free spot", () => {
    const base = createInitialState(config, "finder");
    const range = getLegalStrikerRange(base, config);
    const blocker: CarromCoin = { id: "w1", colour: "white", x: 0, y: range.y };
    const state: CarromState = { ...base, coins: [blocker] };

    const found = findLegalStrikerX(state, 0, config);
    expect(found).not.toBeNull();
    expect(found ?? 0).not.toBe(0);
    expect(isLegalStrikerPlacement(state, { x: found ?? 0, y: range.y }, config)).toBe(true);
  });

  it("returns null when the whole baseline is blocked", () => {
    const base = createInitialState(config, "blocked");
    const range = getLegalStrikerRange(base, config);
    const coins: CarromCoin[] = [];
    for (let x = range.minX; x <= range.maxX; x += 15) {
      coins.push({ id: `w${coins.length + 1}`, colour: "white", x, y: range.y });
    }
    const state: CarromState = { ...base, coins };

    expect(findLegalStrikerX(state, 0, config)).toBeNull();
  });
});

describe("opening formation", () => {
  it("fits on the board without overlapping and with unique ids", () => {
    const state = createInitialState(config, "formation");
    const radius = config.coinDiameterMm / 2;
    const limit = config.boardSizeMm / 2 - radius;
    const ids = new Set(state.coins.map((coin) => coin.id));

    expect(ids.size).toBe(state.coins.length);

    for (const coin of state.coins) {
      expect(Math.abs(coin.x)).toBeLessThanOrEqual(limit);
      expect(Math.abs(coin.y)).toBeLessThanOrEqual(limit);
    }

    for (let first = 0; first < state.coins.length; first += 1) {
      for (let second = first + 1; second < state.coins.length; second += 1) {
        const a = state.coins[first];
        const b = state.coins[second];
        if (a === undefined || b === undefined) {
          continue;
        }
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThanOrEqual(
          2 * radius - config.overlapToleranceMm,
        );
      }
    }
  });
});
