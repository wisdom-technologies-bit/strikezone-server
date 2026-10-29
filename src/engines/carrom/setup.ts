// Informed by reading samiranrl/Carrom_rl (GPL v3) for the rules, board layout
// and shot interface only. This code is original: no line is copied, translated
// or paraphrased from that project. See docs/carrom-rules.md.

import type { CarromConfig } from "./config.js";
import type {
  CarromCoin,
  CarromColour,
  CarromState,
  CarromStrikerRange,
  CarromVec,
} from "./types.js";

/** Radius of a coin. */
export function coinRadius(config: CarromConfig): number {
  return config.coinDiameterMm / 2;
}

/** Radius of the striker. */
export function strikerRadius(config: CarromConfig): number {
  return config.strikerDiameterMm / 2;
}

/** The other player. */
export function opposite(colour: CarromColour): CarromColour {
  return colour === "white" ? "black" : "white";
}

/**
 * The standard opening formation: queen on the centre spot, six coins in a ring
 * around her, twelve in an outer ring, colours alternating in both rings. Ring
 * radii are one and two coin diameters, so coins touch but never overlap.
 */
export function createInitialCoins(config: CarromConfig): CarromCoin[] {
  const spacing = config.coinDiameterMm;
  const half = config.boardSizeMm / 2;

  const coins: CarromCoin[] = [{ id: "queen", colour: "queen", x: 0, y: 0 }];
  const counters: Record<CarromColour, number> = { white: 0, black: 0 };

  const addCoin = (colour: CarromColour, x: number, y: number): void => {
    const index = (counters[colour] += 1);
    const prefix = colour === "white" ? "w" : "b";
    coins.push({ id: `${prefix}${index}`, colour, x: round(x), y: round(y) });
  };

  // Inner ring: six coins, one coin diameter from the centre.
  const innerCount = 6;
  for (let index = 0; index < innerCount; index += 1) {
    const angle = (Math.PI * 2 * index) / innerCount + Math.PI / innerCount;
    const colour: CarromColour = index % 2 === 0 ? "white" : "black";
    addCoin(colour, Math.cos(angle) * spacing, Math.sin(angle) * spacing);
  }

  // Outer ring: twelve coins, two coin diameters out, staggered against the inner ring.
  const outerCount = 12;
  for (let index = 0; index < outerCount; index += 1) {
    const angle = (Math.PI * 2 * index) / outerCount;
    const colour: CarromColour = index % 2 === 0 ? "black" : "white";
    addCoin(colour, Math.cos(angle) * spacing * 2, Math.sin(angle) * spacing * 2);
  }

  // The formation must sit inside the playing area with room to spare.
  const limit = half - coinRadius(config) - config.coinDiameterMm;
  for (const coin of coins) {
    if (Math.abs(coin.x) > limit || Math.abs(coin.y) > limit) {
      throw new RangeError("carrom setup: the opening formation does not fit on the board");
    }
  }

  return coins;
}

/** The baseline of a player: the striker's y, and the legal range of x. */
export function baselineFor(colour: CarromColour, config: CarromConfig): CarromStrikerRange {
  const half = config.boardSizeMm / 2;
  const limit = half - config.baselineEndInsetMm;

  return {
    player: colour,
    side: colour === "white" ? "bottom" : "top",
    y: colour === "white" ? -(half - config.baselineOffsetMm) : half - config.baselineOffsetMm,
    minX: -limit,
    maxX: limit,
  };
}

/** The four pocket centres. */
export function pocketCentres(config: CarromConfig): CarromVec[] {
  const inset = config.boardSizeMm / 2 - config.pocketInsetMm;
  return [
    { x: -inset, y: -inset },
    { x: inset, y: -inset },
    { x: inset, y: inset },
    { x: -inset, y: inset },
  ];
}

/**
 * The free position closest to the centre spot, found by scanning a fixed spiral
 * so a returned coin always lands in the same place for the same board.
 */
export function findFreeSpot(
  coins: readonly CarromCoin[],
  radius: number,
  config: CarromConfig,
): CarromVec {
  const limit = config.boardSizeMm / 2 - radius;
  const spacing = radius * 2;
  const clearanceSq = (spacing - config.overlapToleranceMm) ** 2;

  const isFree = (x: number, y: number): boolean => {
    if (Math.abs(x) > limit || Math.abs(y) > limit) {
      return false;
    }
    for (const coin of coins) {
      const dx = coin.x - x;
      const dy = coin.y - y;
      if (dx * dx + dy * dy < clearanceSq) {
        return false;
      }
    }
    return true;
  };

  if (isFree(0, 0)) {
    return { x: 0, y: 0 };
  }

  for (let ring = 1; ring <= 12; ring += 1) {
    const distance = ring * spacing;
    const points = 6 * ring;
    for (let index = 0; index < points; index += 1) {
      const angle = (Math.PI * 2 * index) / points;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      if (isFree(x, y)) {
        return { x: round(x), y: round(y) };
      }
    }
  }

  // Nothing free anywhere sane: the centre spot is the rule-sanctioned place.
  return { x: 0, y: 0 };
}

/** Distance from the striker to the nearest coin, or Infinity when none is near. */
export function nearestCoinGap(
  state: Pick<CarromState, "coins">,
  position: CarromVec,
  config: CarromConfig,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  const reach = coinRadius(config) + strikerRadius(config);
  for (const coin of state.coins) {
    const dx = coin.x - position.x;
    const dy = coin.y - position.y;
    const gap = Math.sqrt(dx * dx + dy * dy) - reach;
    if (gap < nearest) {
      nearest = gap;
    }
  }
  return nearest;
}

/** Rounds to a thousandth of a millimetre, so state stays small and readable. */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
