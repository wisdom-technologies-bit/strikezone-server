import {
  createInitialState,
  resolveConfig,
  type CarromCoin,
  type CarromState,
} from "../engines/carrom/index.js";
import { applyShot } from "../engines/carrom/index.js";
import { baselineFor } from "../engines/carrom/setup.js";
import { createSeededRng, gaussian } from "../lib/fair-rng.js";
import {
  AIM_ERROR_LEVELS,
  CUT_BUCKETS,
  DISTANCE_BUCKETS,
  SHOTS_PER_CELL,
  type ShotTable,
} from "./shot-grid.js";

/**
 * Calibrating the shot table against the real engine.
 *
 * For every cell of the grid we build a shot with exactly that geometry, add the
 * shooter's aim error, play it through `applyShot`, and count how often the
 * target coin dropped. Nothing is modelled here: the physics decides.
 *
 * Geometry. The board is centred on the origin with white on the negative y
 * side, corner pockets at (±(size/2 - inset)). The coin starts `d` from a pocket
 * on the pocket's diagonal, so the direction it must travel to drop is known.
 * The striker must knock it along that line from `cut` degrees off it, and must
 * itself sit on the shooter's baseline, which fixes where it goes. If the
 * resulting striker position is not legal, the shot is nudged along the
 * baseline and the geometry is re-measured, so every recorded cell is a legal
 * shot.
 */

const CONFIG = resolveConfig({ boardsPerMatch: 1 });

/** Corner pocket centres, in board millimetres. */
const POCKETS: readonly { x: number; y: number }[] = (() => {
  const edge = CONFIG.boardSizeMm / 2 - CONFIG.pocketInsetMm;
  return [
    { x: -edge, y: -edge },
    { x: edge, y: -edge },
    { x: -edge, y: edge },
    { x: edge, y: edge },
  ];
})();

const DEG = Math.PI / 180;

interface Target {
  readonly shooter: "white" | "black";
  readonly pocket: { x: number; y: number };
  readonly coin: CarromCoin;
  readonly striker: { x: number; y: number };
  readonly angle: number;
  readonly power: number;
  readonly cutDegrees: number;
  readonly distanceMm: number;
}

/** The middle of a bucket, so a cell measures a representative shot. */
function middle(value: number, upper: number): number {
  return Number.isFinite(upper) ? (value + upper) / 2 : value * 1.6;
}

function buildTarget(distanceMm: number, cutDegrees: number, variant: number): Target | null {
  const pocket = POCKETS[Math.floor(variant / 25) % POCKETS.length] ?? POCKETS[0];
  if (pocket === undefined) {
    return null;
  }

  // Outward diagonal from the board centre through this pocket.
  const inward = Math.atan2(-pocket.y, -pocket.x);
  const away = inward + Math.PI;

  // The coin sits `distance` from the pocket, swung a little off the diagonal so
  // that coins at the same distance are not all in one spot.
  const swing = (((variant % 25) % 5) - 2) * 0.09;
  const coin = {
    x: pocket.x - distanceMm * Math.cos(away + swing),
    y: pocket.y - distanceMm * Math.sin(away + swing),
  };

  // The coin has to travel towards the pocket.
  const toPocket = Math.atan2(pocket.y - coin.y, pocket.x - coin.x);
  const contact = (CONFIG.strikerDiameterMm + CONFIG.coinDiameterMm) / 2;
  // Shots are measured from white's baseline. Some corner geometries cannot be
  // played from a legal baseline at all; those cells are filled from their
  // neighbours after the sweep rather than pretending they were measured.
  const shooter = "white" as const;
  const range = baselineFor(shooter, CONFIG);
  const cut = cutDegrees * DEG * (Math.floor(variant / 5) % 2 === 0 ? 1 : -1);
  const approach = toPocket + cut;

  // The striker centre sits behind the coin along the approach line, and must
  // have y on the baseline; that fixes how far back it is.
  const sin = Math.sin(approach);
  const cos = Math.cos(approach);
  const back = Math.abs(sin) < 0.25 ? Number.NaN : (coin.y - contact * sin - range.y) / sin;
  const strikerX = coin.x - (contact + back) * cos;

  // A legal shot needs the striker behind the coin, on the baseline, and inside
  // the baseline. Anything else is not a shot a player could take.
  if (
    !Number.isFinite(back) ||
    back < 40 ||
    back > 500 ||
    strikerX < range.minX ||
    strikerX > range.maxX ||
    Math.abs(coin.x) > CONFIG.boardSizeMm / 2 - CONFIG.coinDiameterMm ||
    Math.abs(coin.y) > CONFIG.boardSizeMm / 2 - CONFIG.coinDiameterMm
  ) {
    return null;
  }

  return {
    shooter,
    pocket,
    coin: {
      id: "w-calibration",
      colour: "white",
      x: coin.x,
      y: coin.y,
    } as CarromCoin,
    striker: { x: strikerX, y: range.y },
    angle: approach,
    power: Math.min(0.95, Math.max(0.35, 0.3 + distanceMm / 700)),
    cutDegrees,
    distanceMm,
  };
}

/** A one-coin board with the striker in hand. */
function stateFor(target: Target, seed: string): CarromState {
  const base = createInitialState(CONFIG, seed);
  return {
    ...base,
    turn: target.shooter,
    coins: [target.coin],
    players: {
      white: { score: 0, pocketed: 0, owed: 0 },
      black: { score: 0, pocketed: 0, owed: 0 },
    },
  };
}

/**
 * Fills cells that no legal shot could reach, from the nearest measured cell in
 * the same row and then the same column.
 *
 * A carrom board does not offer every distance at every cut from a legal
 * baseline: a coin sitting between your baseline and the pocket has to be cut,
 * not struck straight. Leaving those cells at zero would make the fast model
 * believe some shots are impossible, which would distort every price downstream.
 */
function fillGaps(matrix: number[][][]): void {
  const FLOOR = 0.025;

  for (const level of matrix) {
    for (const row of level) {
      for (let index = 1; index < row.length; index += 1) {
        if ((row[index] ?? 0) < FLOOR) {
          row[index] = row[index - 1] ?? FLOOR;
        }
      }
      for (let index = row.length - 2; index >= 0; index -= 1) {
        if ((row[index] ?? 0) < FLOOR) {
          row[index] = row[index + 1] ?? FLOOR;
        }
      }
    }

    for (let cut = 0; cut < 6; cut += 1) {
      for (let distance = 1; distance < level.length; distance += 1) {
        const row = level[distance];
        const previous = level[distance - 1];
        if (row !== undefined && previous !== undefined && (row[cut] ?? 0) < FLOOR) {
          row[cut] = previous[cut] ?? FLOOR;
        }
      }
      for (let distance = level.length - 2; distance >= 0; distance -= 1) {
        const row = level[distance];
        const next = level[distance + 1];
        if (row !== undefined && next !== undefined && (row[cut] ?? 0) < FLOOR) {
          row[cut] = next[cut] ?? FLOOR;
        }
      }
    }
  }
}

export interface CalibrationOptions {
  readonly shotsPerCell?: number;
  readonly seedPrefix?: string;
  readonly onCell?: (legalShots: number, cells: number) => void;
}

/** Measures the whole grid. Deterministic for a given seed prefix. */
export function calibrateTable(options: CalibrationOptions = {}): ShotTable {
  const shots = options.shotsPerCell ?? SHOTS_PER_CELL;
  const seedPrefix = options.seedPrefix ?? "calibration";
  const total = AIM_ERROR_LEVELS.length * DISTANCE_BUCKETS.length * CUT_BUCKETS.length;

  const pocketChance = AIM_ERROR_LEVELS.map((aimError, skillIndex) => {
    const shotsForSkill = new Array<number>(DISTANCE_BUCKETS.length)
      .fill(0)
      .map(() => new Array<number>(CUT_BUCKETS.length).fill(0));

    for (let distanceIndex = 0; distanceIndex < DISTANCE_BUCKETS.length; distanceIndex += 1) {
      for (let cutIndex = 0; cutIndex < CUT_BUCKETS.length; cutIndex += 1) {
        const distanceMm = Math.max(
          40,
          middle(
            distanceIndex === 0 ? 25 : (DISTANCE_BUCKETS[distanceIndex - 1] ?? 40),
            DISTANCE_BUCKETS[distanceIndex] ?? 340,
          ),
        );
        const cutDegrees = Math.max(
          2,
          middle(
            cutIndex === 0 ? 0 : (CUT_BUCKETS[cutIndex - 1] ?? 0),
            CUT_BUCKETS[cutIndex] ?? 90,
          ),
        );

        let pocketed = 0;
        let legal = 0;

        for (let attempt = 0; legal < shots && attempt < shots * 12; attempt += 1) {
          const target = buildTarget(distanceMm, cutDegrees, attempt);
          if (target === null) {
            continue;
          }

          const rng = createSeededRng(
            `${seedPrefix}:${String(skillIndex)}:${String(distanceIndex)}:${String(cutIndex)}:${String(legal)}`,
          );
          const error = gaussian(rng) * aimError * DEG;
          const power = Math.min(1, Math.max(0.05, target.power + gaussian(rng) * 0.04));

          try {
            const result = applyShot(stateFor(target, `${seedPrefix}-state`), {
              strikerPosition: target.striker,
              angle: target.angle + error,
              power,
            });
            legal += 1;
            if (
              result.events.some(
                (event) => event.type === "coin_pocketed" && event.coinId === target.coin.id,
              )
            ) {
              pocketed += 1;
            }
          } catch {
            // Not a legal shot: try another geometry rather than counting it.
          }
        }

        const row = shotsForSkill[distanceIndex];
        if (row !== undefined) {
          // A ceiling of 0.75: a coin sitting a few centimetres from the
          // pocket with a clear path is not a certainty in a real frame, and a
          // table that says otherwise would misprice every pot market.
          row[cutIndex] = legal === 0 ? 0.01 : Math.min(0.75, pocketed / legal);
        }
        options.onCell?.(legal, total);
      }
    }

    return shotsForSkill;
  });

  fillGaps(pocketChance);

  return {
    version: 1,
    shotsPerCell: shots,
    aimErrorDegrees: [...AIM_ERROR_LEVELS],
    distanceMaxMm: [...DISTANCE_BUCKETS],
    cutMaxDegrees: [...CUT_BUCKETS],
    pocketChance,
  };
}
