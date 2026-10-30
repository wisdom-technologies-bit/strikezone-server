/**
 * Playing a lot of Ludo, on every core.
 *
 * A pre-match price is a million games inside a minute, which one thread cannot
 * do. This file splits a batch over a worker pool, merges the tallies, and falls
 * back to playing on this thread when a worker cannot be started (a test
 * environment, a restricted sandbox, a machine that refuses the spawn). The
 * fallback is not a degraded mode: it plays the same games and counts the same
 * way, only slower.
 *
 * The split is by seed, not by game: game `i` of a batch is always the game
 * derived from `"${seed}:${i}"`, so a batch is reproducible no matter how many
 * threads played it.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { logger } from "../lib/logger.js";
import { ludoCatalog } from "./catalog/ludo.js";
import {
  countGame,
  countsToObject,
  describeSelections,
  mergeCounts,
  type LudoCounts,
  type SelectionRef,
} from "./ludo-count.js";
import {
  createLudoGameRunner,
  defaultThreads,
  seededUniform,
  type LudoPolicyMix,
} from "./ludo-sim.js";
import type { LudoBotId, LudoConfig } from "../engines/ludo/index.js";
import type { LudoSimJob, LudoSimResult } from "./ludo-sim-worker.js";
import type { CatalogMarket } from "./catalog/carrom.js";

/** What a batch needs. */
export interface LudoBatchRequest {
  readonly games: number;
  readonly seed: string;
  readonly policies: Readonly<Record<number, LudoBotId | LudoPolicyMix>>;
  readonly config?: Partial<LudoConfig>;
  /** Which markets to count. Defaults to the whole catalogue. */
  readonly markets?: readonly CatalogMarket[];
  /** Threads to use. Defaults to every core but one, at most eight. */
  readonly threads?: number;
  /** Set false to make a worker failure an error instead of a fallback. */
  readonly allowInline?: boolean;
}

/** The tally a batch produced. */
export interface LudoBatchResult {
  readonly games: number;
  readonly abandoned: number;
  readonly counts: LudoCounts;
  /** Threads that actually played, for the log and for a test. */
  readonly threads: number;
}

/** Splits `games` into `parts` shares, as evenly as whole games allow. */
export function splitGames(games: number, parts: number): number[] {
  const shares: number[] = [];
  const base = Math.floor(games / Math.max(1, parts));
  let remainder = games - base * parts;
  for (let index = 0; index < parts; index += 1) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    shares.push(base + extra);
  }
  return shares.filter((share) => share > 0);
}

/** Plays a share of the batch on this thread. */
export function runInline(job: LudoSimJob): LudoSimResult {
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

/**
 * The worker entry, or null when this build has no compiled worker next to it.
 *
 * Tests and `tsx` run the TypeScript directly, and node cannot load a `.ts` file
 * on a worker thread without a loader of its own. Rather than pretend, the pool
 * looks for the built worker and plays inline when it is not there: same games,
 * same tallies, one thread.
 */
function workerUrl(): URL | null {
  const candidate = new URL("./ludo-sim-worker.js", import.meta.url);
  return existsSync(fileURLToPath(candidate)) ? candidate : null;
}

/** One worker, one job, settled on its answer or its failure. */
function runWorker(url: URL, job: LudoSimJob): Promise<LudoSimResult> {
  return new Promise<LudoSimResult>((resolve, reject) => {
    const worker = new Worker(url, {
      // Under tsx the worker needs the same loader as the parent; under plain
      // node it needs nothing. Forwarding covers the first and is harmless in
      // the second.
      execArgv: process.execArgv,
    });

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      void worker.terminate().catch(() => undefined);
      fn();
    };

    worker.once("message", (message: LudoSimResult | { error: string }) => {
      if ("error" in message) {
        finish(() => {
          reject(new Error(message.error));
        });
        return;
      }
      finish(() => {
        resolve(message);
      });
    });
    worker.once("error", (error: Error) => {
      finish(() => {
        reject(error);
      });
    });
    worker.once("exit", (code: number) => {
      if (!settled && code !== 0) {
        finish(() => {
          reject(new Error(`the ludo worker exited with code ${String(code)}`));
        });
      }
    });

    worker.postMessage(job);
  });
}

/** The selections a batch should count. */
function refsFor(markets: readonly CatalogMarket[] | undefined): SelectionRef[] {
  return describeSelections(markets ?? ludoCatalog().markets);
}

/**
 * Plays a batch, on workers when it can.
 *
 * A worker that fails to start is not a reason to fail a price: the batch is
 * replayed on this thread, which is slower and exactly as correct.
 */
export async function runLudoBatch(request: LudoBatchRequest): Promise<LudoBatchResult> {
  const refs = refsFor(request.markets);
  const threads = Math.max(1, request.threads ?? defaultThreads());
  const shares = splitGames(request.games, threads);
  const counts: LudoCounts = new Map();
  let abandoned = 0;

  const jobs: LudoSimJob[] = shares.map((games, index) => ({
    games,
    seed: `${request.seed}:part${String(index)}`,
    policies: request.policies,
    config: request.config,
    refs,
  }));

  const url = jobs.length > 1 ? workerUrl() : null;

  if (url !== null) {
    try {
      const results = await Promise.all(jobs.map((job) => runWorker(url, job)));
      for (const result of results) {
        mergeCounts(counts, result.counts);
        abandoned += result.abandoned;
      }
      return { games: request.games, abandoned, counts, threads: results.length };
    } catch (error) {
      if (request.allowInline === false) {
        throw error;
      }
      logger.warn(
        { err: error },
        "the ludo worker pool could not run: playing the batch on this thread",
      );
    }
  }

  for (const job of jobs) {
    const result = runInline(job);
    mergeCounts(counts, result.counts);
    abandoned += result.abandoned;
  }

  return { games: request.games, abandoned, counts, threads: 1 };
}
