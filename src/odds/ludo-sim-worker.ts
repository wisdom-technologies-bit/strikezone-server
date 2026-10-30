/**
 * The worker side of Ludo pricing.
 *
 * One job is: play `games` games from a seed, count every selection the parent
 * asked about, post the tallies back. Nothing else happens here, and nothing is
 * shared between jobs, which is what lets a price scale with cores without any
 * locking.
 *
 * The catalogue is rebuilt in the worker rather than sent to it: it is a pure
 * function of the code, so both sides describe the same markets, and only strings
 * and numbers cross the boundary.
 */

import { parentPort } from "node:worker_threads";
import { ludoCatalog } from "./catalog/ludo.js";
import { countGame, countsToObject, type LudoCounts, type SelectionRef } from "./ludo-count.js";
import { createLudoGameRunner, seededUniform } from "./ludo-sim.js";
import type { LudoPolicyMix } from "./ludo-sim.js";
import type { LudoBotId } from "../engines/ludo/index.js";
import type { LudoConfig } from "../engines/ludo/index.js";

/** What the parent asks a worker to do. */
export interface LudoSimJob {
  readonly games: number;
  /** The seed prefix; game `i` plays `"${seed}:${i}"`, whoever plays it. */
  readonly seed: string;
  readonly policies: Readonly<Record<number, LudoBotId | LudoPolicyMix>>;
  readonly config?: Partial<LudoConfig>;
  readonly refs: readonly SelectionRef[];
}

/** What a worker answers with. */
export interface LudoSimResult {
  readonly games: number;
  readonly abandoned: number;
  readonly counts: Record<string, readonly [number, number]>;
}

if (parentPort === null) {
  throw new Error("the ludo simulator worker must be started as a worker thread");
}

const port = parentPort;

/** Plays the requested games and tallies them. */
export function runJob(job: LudoSimJob): LudoSimResult {
  const catalog = ludoCatalog();
  const runner = createLudoGameRunner({ config: job.config, policies: job.policies });
  const counts: LudoCounts = new Map();
  let abandoned = 0;

  for (let index = 0; index < job.games; index += 1) {
    const stats = runner.play({ random: seededUniform(`${job.seed}:${String(index)}`) });
    if (stats.abandoned) {
      abandoned += 1;
    }
    countGame(catalog, job.refs, stats, counts);
  }

  return { games: job.games, abandoned, counts: countsToObject(counts) };
}

port.on("message", (job: LudoSimJob) => {
  try {
    port.postMessage(runJob(job));
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
