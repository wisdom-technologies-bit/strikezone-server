// Bot policies for carrom. Pure: the state and its own skill numbers go in, one
// shot comes out, and randomness arrives through the match's provably fair
// generator. Nothing here can read bets, stakes, odds or liability (AI_RULES.md
// hard rule 4), and nothing calls Math.random (hard rule 3).
//
// The aiming method is the ghost-ball construction from billiards: to send a coin
// at a pocket, the striker must strike it where a ghost ball, one striker-and-coin
// radius behind the coin on the line to the pocket, would sit. That is standard
// technique, not code from any reference implementation.

import { gaussian, type UniformRng } from "../../lib/fair-rng.js";
import {
  BOT_PROFILES,
  BOT_TUNING,
  botSkillNumbers,
  type BotLevel,
  type BotProfile,
} from "./bot-config.js";
import { DEFAULT_CARROM_CONFIG, type CarromConfig } from "./config.js";
import { findLegalStrikerX, isLegalStrikerPlacement } from "./index.js";
import { baselineFor, coinRadius, pocketCentres, strikerRadius } from "./setup.js";
import type {
  BotPolicy,
  BotSkill,
  CarromCoin,
  CarromShot,
  CarromState,
  CarromVec,
} from "./types.js";

/** One way to try to pot one coin in one pocket, already scored. */
export interface BotCandidate {
  readonly coinId: string;
  /** Which pocket, or -1 for a plain contact shot. */
  readonly pocketIndex: number;
  /** True when the coin is aimed off a cushion. */
  readonly bounce: boolean;
  readonly strikerX: number;
  readonly strikerY: number;
  readonly angle: number;
  readonly power: number;
  /** Higher is better. Always positive. */
  readonly score: number;
  readonly cutDegrees: number;
  readonly pathMm: number;
  /** How many distinct coins sit on the striker's path or the coin's path. */
  readonly blockers: number;
  /** Convenience: true when `blockers` is above zero. */
  readonly blocked: boolean;
  /** True when the ideal striker position had to be clamped onto the baseline. */
  readonly clamped: boolean;
}

const DEGREES = Math.PI / 180;

/**
 * Every own coin against every pocket, using the ghost-ball construction.
 *
 * Pocketed coins are absent from `state.coins`, so only coins on the table
 * produce candidates. The result is sorted best first.
 */
export function botCandidates(
  state: CarromState,
  config: CarromConfig = DEFAULT_CARROM_CONFIG,
): BotCandidate[] {
  const range = baselineFor(state.turn, config);
  const strikeRadius = strikerRadius(config);
  const coinR = coinRadius(config);
  const contactDistance = strikeRadius + coinR;
  const half = config.boardSizeMm / 2;

  const own = state.coins.filter((coin) => coin.colour === state.turn);
  const onTable = state.coins;
  const candidates: BotCandidate[] = [];
  const approaches: BotCandidate[] = [];

  for (const coin of own) {
    const contact = contactCandidate(state, coin, config);
    if (contact !== undefined) {
      approaches.push(contact);
    }

    for (const target of shootingTargets(coin, config)) {
      // Where the striker's centre has to be when it touches the coin.
      const ghostX = coin.x - target.unitX * contactDistance;
      const ghostY = coin.y - target.unitY * contactDistance;

      // The ghost has to be on the table, or the striker cannot get there.
      if (Math.abs(ghostX) > half - strikeRadius || Math.abs(ghostY) > half - strikeRadius) {
        continue;
      }

      // Best striker position: the point on the baseline that meets the ghost as
      // square as possible. Clamping it onto the ends of the baseline turns the
      // shot into a cut, which is still allowed, just scored worse.
      const idealX =
        Math.abs(target.unitY) < 1e-6
          ? ghostX
          : ghostX - ((ghostY - range.y) / target.unitY) * target.unitX;
      const clamped = idealX < range.minX || idealX > range.maxX;
      const strikerX = Math.min(range.maxX, Math.max(range.minX, idealX));

      const dx = ghostX - strikerX;
      const dy = ghostY - range.y;
      const strikerToGhost = Math.hypot(dx, dy);
      if (strikerToGhost < strikeRadius) {
        continue;
      }

      const cosCut = Math.max(
        -1,
        Math.min(1, (dx * target.unitX + dy * target.unitY) / strikerToGhost),
      );
      const cutDegrees = Math.acos(cosCut) / DEGREES;
      if (cutDegrees > 85) {
        continue;
      }

      const blockers = countBlockers(
        [
          {
            from: { x: strikerX, y: range.y },
            to: { x: ghostX, y: ghostY },
            clearance: contactDistance,
          },
          {
            from: { x: coin.x, y: coin.y },
            to: { x: target.x, y: target.y },
            clearance: coinR * 2,
          },
        ],
        onTable,
        coin.id,
        config,
      );

      const coinTravel = target.travelMm * target.travelFactor;
      const pathMm = strikerToGhost + coinTravel;

      candidates.push({
        coinId: coin.id,
        pocketIndex: target.pocketIndex,
        bounce: target.bounce,
        strikerX,
        strikerY: range.y,
        angle: Math.atan2(dy, dx),
        power: powerForPath(strikerToGhost, coinTravel),
        score: scoreCandidate(cutDegrees, pathMm, blockers, clamped),
        cutDegrees,
        pathMm,
        blockers,
        blocked: blockers > 0,
        clamped,
      });
    }
  }

  const sortByScore = (list: BotCandidate[]): BotCandidate[] =>
    list.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.coinId !== right.coinId) {
        return left.coinId < right.coinId ? -1 : 1;
      }
      return left.pocketIndex - right.pocketIndex;
    });

  if (candidates.length > 0) {
    return sortByScore(candidates);
  }

  // No potting line exists: at least put the striker into a coin, so the board
  // changes and a line opens up later.
  return sortByScore(approaches);
}

/** A pocket to aim at, possibly a mirror image reached off a cushion. */
interface ShotTarget {
  readonly x: number;
  readonly y: number;
  /** Which real pocket the coin ends in. */
  readonly pocketIndex: number;
  /** True when the coin has to come off a cushion first. */
  readonly bounce: boolean;
  /** Direction from the coin to the aim point. */
  readonly unitX: number;
  readonly unitY: number;
  /** Distance from the coin to the aim point. */
  readonly travelMm: number;
  /** Extras needed to reach the real pocket: a cushion eats energy. */
  readonly travelFactor: number;
}

/**
 * Every pocket, plus the mirror image of every pocket across every wall.
 *
 * A coin level with a pocket, or tucked behind the baseline, cannot be struck
 * straight into it: the striker would have to hit it at ninety degrees, which
 * transfers almost nothing. Aiming at the pocket's reflection instead sends the
 * coin into the cushion first and in off the bounce, which is how a carrom player
 * takes those coins.
 */
function shootingTargets(coin: CarromCoin, config: CarromConfig): ShotTarget[] {
  const half = config.boardSizeMm / 2;
  const edge = half - coinRadius(config);
  const pockets = pocketCentres(config);
  const targets: ShotTarget[] = [];

  const add = (
    aim: CarromVec,
    pocketIndex: number,
    bounce: boolean,
    travelFactor: number,
    bouncePoint?: CarromVec,
  ): void => {
    const dx = aim.x - coin.x;
    const dy = aim.y - coin.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) {
      return;
    }

    if (bouncePoint !== undefined) {
      // The bounce has to happen on the cushion, not around a corner.
      const inside = Math.abs(bouncePoint.x) <= edge + 0.5 && Math.abs(bouncePoint.y) <= edge + 0.5;
      if (!inside) {
        return;
      }
    }

    targets.push({
      x: aim.x,
      y: aim.y,
      pocketIndex,
      bounce,
      unitX: dx / distance,
      unitY: dy / distance,
      travelMm: distance,
      travelFactor,
    });
  };

  for (let index = 0; index < pockets.length; index += 1) {
    const pocket = pockets[index];
    if (pocket === undefined) {
      continue;
    }
    add(pocket, index, false, 1);

    for (const wall of WALLS) {
      const mirrored = mirrorAcross(pocket, wall, half);
      const bouncePoint = crossingPoint(coin, mirrored, wall, half);
      add(mirrored, index, true, 1.9, bouncePoint);
    }
  }

  return targets;
}

const WALLS = ["left", "right", "bottom", "top"] as const;
type Wall = (typeof WALLS)[number];

/** Reflects a point across one wall of the table. */
function mirrorAcross(point: CarromVec, wall: Wall, half: number): CarromVec {
  switch (wall) {
    case "left":
      return { x: -half - (point.x + half), y: point.y };
    case "right":
      return { x: half + (half - point.x), y: point.y };
    case "bottom":
      return { x: point.x, y: -half - (point.y + half) };
    default:
      return { x: point.x, y: half + (half - point.y) };
  }
}

/** Where the straight line to a mirrored aim point crosses the cushion. */
function crossingPoint(
  from: CarromVec,
  to: CarromVec,
  wall: Wall,
  half: number,
): CarromVec | undefined {
  const plane = wall === "left" || wall === "right" ? "x" : "y";
  const limit = wall === "left" || wall === "bottom" ? -half : half;
  const startValue = plane === "x" ? from.x : from.y;
  const delta = (plane === "x" ? to.x : to.y) - startValue;

  if (Math.abs(delta) < 1e-9) {
    return undefined;
  }

  const t = (limit - startValue) / delta;
  if (t <= 0 || t > 1) {
    return undefined;
  }

  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/**
 * The simplest useful shot at a coin: strike it straight on, with no pocket in
 * mind. Used only when no potting candidate exists at all.
 */
function contactCandidate(
  state: CarromState,
  coin: CarromCoin,
  config: CarromConfig,
): BotCandidate | undefined {
  const range = baselineFor(state.turn, config);
  const contactDistance = strikerRadius(config) + coinRadius(config);
  const strikerX = findLegalStrikerX(state, coin.x, config);
  if (strikerX === null) {
    return undefined;
  }

  const dx = coin.x - strikerX;
  const dy = coin.y - range.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= contactDistance) {
    return undefined;
  }

  const strikerTravel = distance - contactDistance;

  return {
    coinId: coin.id,
    pocketIndex: -1,
    bounce: false,
    strikerX,
    strikerY: range.y,
    angle: Math.atan2(dy, dx),
    power: powerForPath(strikerTravel, 0),
    score: scoreCandidate(0, distance, 0, false) * BOT_TUNING.approachDiscount,
    cutDegrees: 0,
    pathMm: distance,
    blockers: 0,
    blocked: false,
    clamped: false,
  };
}

/**
 * Higher is better: a straight, short, unblocked shot scores near 1, a long cut
 * through a rattle scores near 0, and no candidate ever scores 0 (which would make
 * it impossible to weight the choice).
 *
 * Each coin on the path costs a fixed penalty rather than a flat "blocked"
 * penalty, so a shot that grazes one coin still rates above a shot buried behind
 * four: on a packed opening rack every shot touches something.
 */
export function scoreCandidate(
  cutDegrees: number,
  pathMm: number,
  blockers: number,
  clamped: boolean,
): number {
  const cutPenalty = (cutDegrees / BOT_TUNING.cutAngleScaleDegrees) ** 2;
  const distancePenalty = (pathMm / BOT_TUNING.distanceScaleMm) ** 2;
  const blockerPenalty = Math.min(
    BOT_TUNING.maxBlockerPenalty,
    Math.max(0, blockers) * BOT_TUNING.blockerPenalty,
  );

  return (
    1 /
    (1 + cutPenalty + distancePenalty + blockerPenalty + (clamped ? BOT_TUNING.clampedPenalty : 0))
  );
}

/**
 * The power that should just carry the striker to the coin and then the coin to
 * the pocket, derived from the board's own physics constants rather than guessed.
 */
export function powerForPath(strikerTravelMm: number, coinTravelMm: number): number {
  const needed =
    strikerTravelMm * BOT_TUNING.strikerTravelFactor + coinTravelMm * BOT_TUNING.coinTravelFactor;
  const power = Math.sqrt(needed / BOT_TUNING.fullPowerTravelMm);

  return Math.min(BOT_TUNING.maxPower, Math.max(BOT_TUNING.minPower, power));
}

/** One straight leg of a shot: the striker to the contact point, or coin to pocket. */
interface PathLeg {
  readonly from: CarromVec;
  readonly to: CarromVec;
  /** How close another coin may come to the line before it counts as a blocker. */
  readonly clearance: number;
}

/** How many distinct coins sit on any of the given legs. */
function countBlockers(
  legs: readonly PathLeg[],
  coins: readonly CarromCoin[],
  ignoreCoinId: string,
  config: CarromConfig,
): number {
  const samples = BOT_TUNING.pathSamples;
  const coinR = coinRadius(config);
  const blocked = new Set<string>();

  for (const leg of legs) {
    for (let index = 1; index <= samples; index += 1) {
      const t = index / samples;
      const x = leg.from.x + (leg.to.x - leg.from.x) * t;
      const y = leg.from.y + (leg.to.y - leg.from.y) * t;

      for (const coin of coins) {
        if (coin.id === ignoreCoinId || blocked.has(coin.id)) {
          continue;
        }
        if (
          Math.hypot(coin.x - x, coin.y - y) <
          leg.clearance + coinR - config.overlapToleranceMm
        ) {
          blocked.add(coin.id);
        }
      }
    }
  }

  return blocked.size;
}

/**
 * Picks one candidate with a softmax weighted by `selectionQuality`.
 *
 * Quality 1 always picks the best candidate; quality 0 is close to a uniform pick
 * across the list. Candidates arrive sorted best first, so the walk is
 * deterministic for a given random number.
 */
export function chooseCandidate(
  candidates: readonly BotCandidate[],
  selectionQuality: number,
  rng: UniformRng,
): BotCandidate | undefined {
  const first = candidates[0];
  if (first === undefined) {
    return undefined;
  }

  const quality = Math.min(1, Math.max(0, selectionQuality));
  const temperature = Math.max(
    BOT_TUNING.softmaxTemperatureFloor,
    BOT_TUNING.softmaxTemperatureScale * (1 - quality),
  );

  // Scores sit in a narrow band (0.85 to 0.95 is a wide gap for these shots), so
  // spreading them across [0, 1] first is what makes the temperature mean the same
  // thing on a cluttered board as on a nearly empty one.
  const worst = candidates[candidates.length - 1]?.score ?? first.score;
  const spread = first.score - worst;
  const normalise = (score: number): number => (spread > 0 ? (score - worst) / spread : 1);

  const weights = candidates.map((candidate) => Math.exp(normalise(candidate.score) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let target = rng.nextFloat() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    target -= weights[index] ?? 0;
    if (target <= 0) {
      return candidates[index];
    }
  }

  return candidates[candidates.length - 1];
}

/**
 * Applies the bot's aim and power error to a chosen candidate, drawn from the
 * match's fair generator, and returns a shot the engine will accept.
 */
export function withShotNoise(
  candidate: BotCandidate,
  level: BotLevel,
  skill: Readonly<Record<string, number>>,
  rng: UniformRng,
): CarromShot {
  const numbers = botSkillNumbers(level, skill);
  const angle = candidate.angle + gaussian(rng) * numbers.aimErrorDegrees * DEGREES;
  const noisedPower = candidate.power * (1 + gaussian(rng) * numbers.powerErrorFraction);

  return {
    strikerPosition: { x: candidate.strikerX, y: candidate.strikerY },
    angle,
    power: Number.isFinite(noisedPower)
      ? Math.min(1, Math.max(0.01, noisedPower))
      : candidate.power,
  };
}

/**
 * The last resort: a legal, low-power shot up the board. Used when a player has
 * no own coin to aim at, and by the referee when a turn timer expires.
 */
export function safeShot(
  state: CarromState,
  config: CarromConfig = DEFAULT_CARROM_CONFIG,
): CarromShot {
  const range = baselineFor(state.turn, config);
  const strikerX = findLegalStrikerX(state, 0, config) ?? range.minX;
  const up = state.turn === "white" ? Math.PI / 2 : -Math.PI / 2;

  return { strikerPosition: { x: strikerX, y: range.y }, angle: up, power: 0.4 };
}

/**
 * The whole decision for one turn: candidates, softmax choice, then noise. Split
 * out from the policy object so a test can drive it directly.
 */
export function chooseBotShot(
  level: BotLevel,
  state: CarromState,
  rng: UniformRng,
  skill: Readonly<Record<string, number>> = {},
  config: CarromConfig = DEFAULT_CARROM_CONFIG,
): CarromShot {
  const numbers = botSkillNumbers(level, skill);
  const candidates = botCandidates(state, config);
  const chosen = chooseCandidate(candidates, numbers.selectionQuality, rng);

  if (chosen === undefined) {
    return safeShot(state, config);
  }

  const shot = withShotNoise(chosen, level, skill, rng);

  // The angle and power were noised, never the position, but a coin may have been
  // closer than the candidate assumed: make sure the engine will accept it.
  if (isLegalStrikerPlacement(state, shot.strikerPosition, config)) {
    return shot;
  }

  const fallbackX = findLegalStrikerX(state, shot.strikerPosition.x, config);
  if (fallbackX === null) {
    return safeShot(state, config);
  }

  return { ...shot, strikerPosition: { x: fallbackX, y: shot.strikerPosition.y } };
}

/** A bot level as the API publishes it. */
export interface PublishedBot extends BotProfile {
  readonly isBot: true;
}

/** The catalogue for GET /api/bots: names, policies and the exact numbers. */
export function publishedBots(): PublishedBot[] {
  return Object.values(BOT_PROFILES).map((profile) => ({ ...profile, isBot: true }));
}

/** A policy object for a level, ready to hand to a room. */
export function createBotPolicy(level: BotLevel): BotPolicy {
  const profile = BOT_PROFILES[level];

  return {
    id: profile.policy,
    chooseShot(
      state: CarromState,
      rng: UniformRng,
      skill: BotSkill,
      config: CarromConfig = DEFAULT_CARROM_CONFIG,
    ): CarromShot {
      return chooseBotShot(level, state, rng, skill, config);
    },
  };
}

/** Policies by level, created once. */
export const BOT_POLICIES: Readonly<Record<BotLevel, BotPolicy>> = Object.freeze({
  rookie: createBotPolicy("rookie"),
  club: createBotPolicy("club"),
  master: createBotPolicy("master"),
});
