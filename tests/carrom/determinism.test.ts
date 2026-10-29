import { describe, expect, it } from "vitest";
import {
  applyShot,
  createInitialState,
  findLegalStrikerX,
  getLegalStrikerRange,
  type CarromShot,
  type CarromState,
} from "../../src/engines/carrom/index.js";
import { createSeededRng } from "../../src/lib/fair-rng.js";
import { config } from "./helpers.js";

function firstLegalShot(state: CarromState): CarromShot {
  const range = getLegalStrikerRange(state, config);
  const x = findLegalStrikerX(state, 0, config);
  if (x === null) {
    throw new Error("no legal striker position");
  }
  return { strikerPosition: { x, y: range.y }, angle: Math.PI / 2, power: 0.85 };
}

describe("determinism", () => {
  it("produces the same state, events and frames for the same input", () => {
    const state = createInitialState(config, "determinism-seed");
    const shot = firstLegalShot(state);

    const first = applyShot(state, shot, { config, recordFrames: true });
    const second = applyShot(state, shot, { config, recordFrames: true });

    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
    expect(JSON.stringify(second.frames)).toBe(JSON.stringify(first.frames));
    expect(first.frames?.frames.length ?? 0).toBeGreaterThan(1);
  });

  it("replays a whole sequence of shots identically", () => {
    const play = (): string => {
      const rng = createSeededRng("sequence-seed");
      let state = createInitialState(config, "sequence-seed");
      const log: string[] = [];

      for (let index = 0; index < 12; index += 1) {
        const range = getLegalStrikerRange(state, config);
        const coin = rng.pick(state.coins);
        const preferred = Math.min(range.maxX, Math.max(range.minX, coin.x));
        const x = findLegalStrikerX(state, preferred, config);
        if (x === null || state.phase === "match_ended") {
          break;
        }
        const shot: CarromShot = {
          strikerPosition: { x, y: range.y },
          angle: Math.atan2(coin.y - range.y, coin.x - x),
          power: 0.5 + rng.nextFloat() * 0.45,
        };
        const result = applyShot(state, shot, { config });
        log.push(JSON.stringify(result.events));
        state = result.state;
      }

      log.push(JSON.stringify(state));
      return log.join("|");
    };

    expect(play()).toBe(play());
  });

  it("gives the same opening for the same seed", () => {
    expect(JSON.stringify(createInitialState(config, "seed-a"))).toBe(
      JSON.stringify(createInitialState(config, "seed-a")),
    );
  });
});
