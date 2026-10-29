import { performance } from "node:perf_hooks";
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

const SHOTS = 20;
const BUDGET_MS = 20;

function playBoard(seed: string): CarromState {
  const rng = createSeededRng(seed);
  let state = createInitialState(config, seed);

  for (let index = 0; index < SHOTS; index += 1) {
    if (state.phase === "match_ended") {
      break;
    }
    const range = getLegalStrikerRange(state, config);
    const target = rng.pick(state.coins);
    const preferred = Math.min(range.maxX, Math.max(range.minX, target.x));
    const x = findLegalStrikerX(state, preferred, config);
    if (x === null) {
      break;
    }
    const shot: CarromShot = {
      strikerPosition: { x, y: range.y },
      angle: Math.atan2(target.y - range.y, target.x - x),
      power: 0.5 + rng.nextFloat() * 0.45,
    };
    state = applyShot(state, shot, { config }).state;
  }

  return state;
}

describe("performance", () => {
  it(`simulates ${SHOTS} shots without frames in under ${BUDGET_MS} ms`, () => {
    // Warm up, then take the best of three runs: this measures the engine, not
    // the first-call cost of the JIT.
    playBoard("perf-warmup");

    const runs: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      playBoard(`perf-${run}`);
      runs.push(performance.now() - started);
    }

    const best = Math.min(...runs);
    console.log(
      `carrom performance: ${SHOTS} shots in ${best.toFixed(2)} ms ` +
        `(${(best / SHOTS).toFixed(3)} ms per shot, runs: ${runs.map((run) => run.toFixed(2)).join(", ")})`,
    );

    expect(best).toBeLessThan(BUDGET_MS);
  });
});
