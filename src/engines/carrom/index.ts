// Informed by reading samiranrl/Carrom_rl (GPL v3) for the rules, board layout
// and shot interface only. This code is original: no line is copied, translated
// or paraphrased from that project. See docs/carrom-rules.md.

import { z } from "zod";
import { DEFAULT_CARROM_CONFIG, resolveConfig, type CarromConfig } from "./config.js";
import { simulateShot } from "./physics.js";
import { resolveShot } from "./rules.js";
import {
  baselineFor,
  createInitialCoins,
  nearestCoinGap,
  opposite,
  strikerRadius,
} from "./setup.js";
import type {
  CarromColour,
  CarromShot,
  CarromShotOptions,
  CarromShotResult,
  CarromState,
  CarromStrikerRange,
  CarromVec,
} from "./types.js";

export { DEFAULT_CARROM_CONFIG, resolveConfig } from "./config.js";
export type { CarromConfig } from "./config.js";
export { opposite } from "./setup.js";
export type {
  BotPolicy,
  BotSkill,
  CarromCoin,
  CarromColour,
  CarromEvent,
  CarromFoulReason,
  CarromFrame,
  CarromFrameBody,
  CarromFrames,
  CarromPhase,
  CarromPlayerState,
  CarromQueenReturnReason,
  CarromQueenState,
  CarromShot,
  CarromShotOptions,
  CarromShotResult,
  CarromState,
  CarromStrikerRange,
  CarromVec,
  CoinColour,
} from "./types.js";

/** A shot exactly as the engine accepts it: no unknown fields, power in range. */
const shotSchema = z.strictObject({
  strikerPosition: z.strictObject({
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  angle: z.number().finite(),
  power: z.number().min(0).max(1),
});

/** Tolerance for placing the striker on the baseline, in millimetres. */
const PLACEMENT_TOLERANCE_MM = 0.5;

/**
 * A new match: the standard opening formation, white to break, scores at zero.
 *
 * The formation is fixed by the rules, so `seed` does not change it; the seed is
 * kept in the state so the match can be committed to before play and replayed
 * afterwards.
 */
export function createInitialState(
  config: CarromConfig = DEFAULT_CARROM_CONFIG,
  seed = "0",
): CarromState {
  const settings = resolveConfig(config);

  return {
    v: 1,
    seed,
    board: 1,
    shot: 0,
    turn: "white",
    phase: "aiming",
    queen: { onBoard: true, coveredBy: null, pending: null },
    coins: createInitialCoins(settings),
    striker: null,
    players: {
      white: { score: 0, pocketed: 0, owed: 0 },
      black: { score: 0, pocketed: 0, owed: 0 },
    },
  };
}

/**
 * The striker zone for the player whose turn it is: the baseline they shoot from
 * and the range of x they may place the striker in.
 */
export function getLegalStrikerRange(
  state: CarromState,
  config: CarromConfig = DEFAULT_CARROM_CONFIG,
): CarromStrikerRange {
  return baselineFor(state.turn, resolveConfig(config));
}

/**
 * Whether the striker may be placed here: on the player's baseline, inside the
 * legal x range, and clear of every coin.
 */
export function isLegalStrikerPlacement(
  state: CarromState,
  position: CarromVec,
  config: CarromConfig = DEFAULT_CARROM_CONFIG,
): boolean {
  const settings = resolveConfig(config);
  const range = baselineFor(state.turn, settings);

  if (Math.abs(position.y - range.y) > PLACEMENT_TOLERANCE_MM) {
    return false;
  }
  if (position.x < range.minX || position.x > range.maxX) {
    return false;
  }
  return nearestCoinGap(state, position, settings) >= settings.strikerClearanceMm;
}

/**
 * The nearest legal striker x to `preferredX`, or null when the baseline is
 * blocked. Bots and the demo use this so they never place an illegal striker.
 */
export function findLegalStrikerX(
  state: CarromState,
  preferredX: number,
  config: CarromConfig = DEFAULT_CARROM_CONFIG,
): number | null {
  const settings = resolveConfig(config);
  const range = baselineFor(state.turn, settings);
  const start = Math.min(range.maxX, Math.max(range.minX, preferredX));
  const step = strikerRadius(settings) / 4;

  if (isLegalStrikerPlacement(state, { x: start, y: range.y }, settings)) {
    return start;
  }

  for (let offset = step; offset <= range.maxX - range.minX; offset += step) {
    const right = start + offset;
    if (right <= range.maxX && isLegalStrikerPlacement(state, { x: right, y: range.y }, settings)) {
      return right;
    }
    const left = start - offset;
    if (left >= range.minX && isLegalStrikerPlacement(state, { x: left, y: range.y }, settings)) {
      return left;
    }
  }

  return null;
}

/**
 * Plays one shot: validates it, runs the physics to rest, then applies the rules.
 *
 * `state` is not modified. The returned state is the position for the next shot,
 * or the end of the match. Frames are recorded only when
 * `options.recordFrames` is true, because a full recording is much larger than
 * the state and the odds simulator does not need it.
 *
 * Throws a ZodError for a malformed shot, and a RangeError for a well-formed shot
 * that breaks a placement rule.
 */
export function applyShot(
  state: CarromState,
  shot: CarromShot,
  options: CarromShotOptions = {},
): CarromShotResult {
  const settings = resolveConfig(options.config ?? DEFAULT_CARROM_CONFIG);
  const parsed = shotSchema.parse(shot);

  if (state.phase === "match_ended") {
    throw new RangeError("carrom: the match has ended, start a new one");
  }

  if (!isLegalStrikerPlacement(state, parsed.strikerPosition, settings)) {
    const range = baselineFor(state.turn, settings);
    throw new RangeError(
      `carrom: illegal striker placement at x=${parsed.strikerPosition.x}, y=${parsed.strikerPosition.y}; ` +
        `the ${state.turn} baseline is y=${range.y} with x between ${range.minX} and ${range.maxX}, clear of every coin`,
    );
  }

  const outcome = simulateShot(state, parsed, settings, {
    recordFrames: options.recordFrames === true,
    fps: options.fps ?? settings.framesPerSecond,
  });
  const resolved = resolveShot(state, outcome, settings);

  return {
    state: resolved.state,
    events: resolved.events,
    frames: outcome.frames,
  };
}

/** Which colour a player shoots for. White is player 1 and breaks. */
export function colourForPlayer(player: 1 | 2): CarromColour {
  return player === 1 ? "white" : "black";
}

/** The number of the player whose turn it is: 1 for white, 2 for black. */
export function playerForTurn(state: CarromState): 1 | 2 {
  return state.turn === "white" ? 1 : 2;
}

/** Convenience: the colour that is not shooting. */
export function waitingColour(state: CarromState): CarromColour {
  return opposite(state.turn);
}
