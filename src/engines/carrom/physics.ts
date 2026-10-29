// Informed by reading samiranrl/Carrom_rl (GPL v3) for the rules, board layout
// and shot interface only. This code is original: no line is copied, translated
// or paraphrased from that project. See docs/carrom-rules.md.

import type { CarromConfig } from "./config.js";
import { coinRadius, pocketCentres, round, strikerRadius } from "./setup.js";
import type {
  CarromCoin,
  CarromFrame,
  CarromFrames,
  CarromShot,
  CarromState,
  CarromVec,
  CoinColour,
} from "./types.js";

/** What kind of body was pocketed. */
export type PocketedKind = "coin" | "striker";

/** A body that dropped into a pocket during a shot. */
export interface PocketedBody {
  readonly id: string;
  readonly kind: PocketedKind;
  readonly colour: CoinColour | null;
}

/** Everything the rules need to know about how a shot physically ended. */
export interface ShotOutcome {
  /** Coins still on the board, at rest in their final positions. */
  readonly coins: CarromCoin[];
  /** Where the striker stopped, or null if it was pocketed. */
  readonly striker: CarromVec | null;
  readonly pocketed: PocketedBody[];
  readonly frames: CarromFrames | null;
}

/** Options for the simulation: recording is opt-in so the odds path stays fast. */
export interface SimulationOptions {
  readonly recordFrames: boolean;
  readonly fps: number;
}

/** A body inside the simulation: the state version plus velocity, radius and mass. */
interface Body {
  readonly id: string;
  readonly kind: PocketedKind;
  readonly colour: CoinColour | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  readonly r: number;
  readonly m: number;
  pocketed: boolean;
}

/**
 * Runs one shot to rest and reports where everything ended up.
 *
 * Fixed timestep, no randomness, no clock, arrays traversed in a fixed order: the
 * same state, shot and config always produce the same outcome on the same
 * machine. Nothing here knows the rules of carrom; pocketing is geometry, and
 * {@link resolveShot} decides what it means.
 */
export function simulateShot(
  state: CarromState,
  shot: CarromShot,
  config: CarromConfig,
  options: SimulationOptions,
): ShotOutcome {
  const bodies = buildBodies(state, shot, config);
  const pockets = pocketCentres(config);
  const captureSq = (config.pocketDiameterMm / 2) ** 2;
  const half = config.boardSizeMm / 2;

  const pocketsHit: PocketedBody[] = [];
  const frames: CarromFrame[] = [];

  const dt = config.stepSeconds;
  const maxSteps = Math.max(1, Math.ceil(config.maxShotSeconds / dt));
  const friction = config.rollingFrictionMmPerS2 * dt;
  const framesPerSecond = options.fps > 0 ? options.fps : config.framesPerSecond;
  const stepsPerFrame = Math.max(1, Math.round(1 / (framesPerSecond * dt)));

  if (options.recordFrames) {
    frames.push(snapshot(bodies, 0));
  }

  for (let step = 0; step < maxSteps; step += 1) {
    // 1. Rolling friction, then integration.
    for (const body of bodies) {
      if (body.pocketed) {
        continue;
      }
      const speed = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
      if (speed > 0) {
        if (speed <= friction + config.stopSpeedMmPerS) {
          body.vx = 0;
          body.vy = 0;
        } else {
          const scale = (speed - friction) / speed;
          body.vx *= scale;
          body.vy *= scale;
        }
      }
      body.x += body.vx * dt;
      body.y += body.vy * dt;
    }

    // 2. Pockets, before walls, so a coin entering a pocket cannot bounce out.
    for (const body of bodies) {
      if (body.pocketed) {
        continue;
      }
      for (const pocket of pockets) {
        const dx = body.x - pocket.x;
        const dy = body.y - pocket.y;
        if (dx * dx + dy * dy <= captureSq) {
          body.pocketed = true;
          body.vx = 0;
          body.vy = 0;
          pocketsHit.push({ id: body.id, kind: body.kind, colour: body.colour });
          break;
        }
      }
    }

    // 3. Walls.
    clampToWalls(bodies, half);

    // 4. Every pair of bodies, repeated while contacts remain, so a cluster
    //    resolves within one step instead of smearing over several.
    for (let pass = 0; pass < config.collisionIterations; pass += 1) {
      const touched = resolvePairs(bodies, config.coinRestitution, config.overlapToleranceMm);
      if (!touched) {
        break;
      }
    }

    // 5. Collision corrections must not push a body through a wall.
    clampToWalls(bodies, half);

    if (options.recordFrames && (step + 1) % stepsPerFrame === 0) {
      frames.push(snapshot(bodies, (step + 1) * dt));
    }

    if (!anyMoving(bodies)) {
      break;
    }
  }

  // Anything still moving at the time limit is stopped where it is.
  for (const body of bodies) {
    body.vx = 0;
    body.vy = 0;
  }

  separateRestingBodies(bodies, config);
  clampToWalls(bodies, half);

  return finish(bodies, pocketsHit, options, frames, framesPerSecond);
}

function buildBodies(state: CarromState, shot: CarromShot, config: CarromConfig): Body[] {
  const bodyRadius = coinRadius(config);
  const bodies: Body[] = state.coins.map((coin) => ({
    id: coin.id,
    kind: "coin" as const,
    colour: coin.colour,
    x: coin.x,
    y: coin.y,
    vx: 0,
    vy: 0,
    r: bodyRadius,
    m: config.coinMassG,
    pocketed: false,
  }));

  const speed = config.maxShotSpeedMmPerS * shot.power;
  bodies.push({
    id: "striker",
    kind: "striker",
    colour: null,
    x: shot.strikerPosition.x,
    y: shot.strikerPosition.y,
    vx: Math.cos(shot.angle) * speed,
    vy: Math.sin(shot.angle) * speed,
    r: strikerRadius(config),
    m: config.strikerMassG,
    pocketed: false,
  });

  return bodies;
}

/** True when a body has no velocity, so it can neither start nor change a contact. */
function atRest(body: Body): boolean {
  return body.vx === 0 && body.vy === 0;
}

function anyMoving(bodies: readonly Body[]): boolean {
  for (const body of bodies) {
    if (!body.pocketed && (body.vx !== 0 || body.vy !== 0)) {
      return true;
    }
  }
  return false;
}

/** Keeps a body inside the playing area, reflecting its velocity at the wall. */
function clampToWalls(bodies: readonly Body[], half: number): void {
  for (const body of bodies) {
    if (body.pocketed) {
      continue;
    }
    bounceAxis(body, half);
  }
}

function bounceAxis(body: Body, half: number): void {
  const min = -half + body.r;
  const max = half - body.r;

  if (body.x < min) {
    body.x = min;
    if (body.vx < 0) {
      body.vx = -body.vx;
    }
  } else if (body.x > max) {
    body.x = max;
    if (body.vx > 0) {
      body.vx = -body.vx;
    }
  }

  if (body.y < min) {
    body.y = min;
    if (body.vy < 0) {
      body.vy = -body.vy;
    }
  } else if (body.y > max) {
    body.y = max;
    if (body.vy > 0) {
      body.vy = -body.vy;
    }
  }
}

/**
 * One pass over all pairs: separate any overlap, then exchange an impulse along
 * the contact normal. Bodies already moving apart are left alone, so a stack of
 * touching coins does not jitter. Returns true when any pair was in contact.
 */
function resolvePairs(bodies: readonly Body[], restitution: number, tolerance: number): boolean {
  const count = bodies.length;
  let touched = false;

  for (let first = 0; first < count; first += 1) {
    const a = bodies[first];
    if (a === undefined || a.pocketed) {
      continue;
    }

    for (let second = first + 1; second < count; second += 1) {
      const b = bodies[second];
      if (b === undefined || b.pocketed) {
        continue;
      }

      // Two bodies sitting still cannot start a collision; skipping them is the
      // difference between checking every pair and checking only the action.
      if (atRest(a) && atRest(b)) {
        continue;
      }

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const reach = a.r + b.r;
      const distanceSq = dx * dx + dy * dy;

      if (distanceSq >= reach * reach || distanceSq === 0) {
        continue;
      }

      touched = true;
      const distance = Math.sqrt(distanceSq);
      const nx = dx / distance;
      const ny = dy / distance;
      const inverseA = 1 / a.m;
      const inverseB = 1 / b.m;
      const inverseSum = inverseA + inverseB;

      const overlap = reach - distance - tolerance;
      if (overlap > 0) {
        a.x -= nx * overlap * (inverseA / inverseSum);
        a.y -= ny * overlap * (inverseA / inverseSum);
        b.x += nx * overlap * (inverseB / inverseSum);
        b.y += ny * overlap * (inverseB / inverseSum);
      }

      const relativeNormal = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (relativeNormal > 0) {
        continue;
      }

      const impulse = (-(1 + restitution) * relativeNormal) / inverseSum;
      a.vx -= impulse * inverseA * nx;
      a.vy -= impulse * inverseA * ny;
      b.vx += impulse * inverseB * nx;
      b.vy += impulse * inverseB * ny;
    }
  }

  return touched;
}

/**
 * Final pass after everything stops: guarantees the state we hand back has no
 * two bodies overlapping, even if a cluster settled very slowly.
 */
function separateRestingBodies(bodies: readonly Body[], config: CarromConfig): void {
  for (let pass = 0; pass < 16; pass += 1) {
    let overlaps = 0;
    const count = bodies.length;

    for (let first = 0; first < count; first += 1) {
      const a = bodies[first];
      if (a === undefined || a.pocketed) {
        continue;
      }
      for (let second = first + 1; second < count; second += 1) {
        const b = bodies[second];
        if (b === undefined || b.pocketed) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const reach = a.r + b.r;
        const distanceSq = dx * dx + dy * dy;
        const limit = reach - config.overlapToleranceMm;
        if (distanceSq >= limit * limit) {
          continue;
        }
        overlaps += 1;
        const distance = Math.sqrt(distanceSq);
        const nx = distance === 0 ? 1 : dx / distance;
        const ny = distance === 0 ? 0 : dy / distance;
        const push = (limit - distance) / 2;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
      }
    }

    if (overlaps === 0) {
      break;
    }
  }
}

function snapshot(bodies: readonly Body[], t: number): CarromFrame {
  const positions = bodies
    .filter((body) => !body.pocketed)
    .map((body) => ({ id: body.id, x: round(body.x), y: round(body.y) }));
  return { t: round(t), bodies: positions };
}

function finish(
  bodies: readonly Body[],
  pocketsHit: readonly PocketedBody[],
  options: SimulationOptions,
  frames: readonly CarromFrame[],
  fps: number,
): ShotOutcome {
  const coins: CarromCoin[] = [];
  let striker: CarromVec | null = null;

  for (const body of bodies) {
    if (body.kind === "striker") {
      striker = body.pocketed ? null : { x: round(body.x), y: round(body.y) };
      continue;
    }
    if (body.pocketed || body.colour === null) {
      continue;
    }
    coins.push({ id: body.id, colour: body.colour, x: round(body.x), y: round(body.y) });
  }

  return {
    coins,
    striker,
    pocketed: [...pocketsHit],
    frames: options.recordFrames ? { fps, frames: [...frames] } : null,
  };
}
