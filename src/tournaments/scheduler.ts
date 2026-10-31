import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { TournamentRepository } from "./repository.js";
import type { TournamentService } from "./service.js";
import type { TournamentRecord } from "./types.js";

/**
 * The job runner.
 *
 * Every ten seconds it asks one question - what is due? - and does it: open a
 * tournament whose registration time has come, start one whose start time has
 * come, launch the matches whose turn it is, and settle whatever has finished.
 *
 * Two properties matter more than the schedule:
 *
 * 1. **It is safe to run twice.** A lease decides which instance runs a tick, and
 *    every write inside the tick is a conditional update, so even a lease failure
 *    cannot launch a match twice or pay a tournament twice.
 * 2. **It resumes.** Nothing is held in memory: `resume()` on startup is the same
 *    code as a tick, so a server that died in the middle of round two picks up
 *    exactly there - the bracket, the results and the money are all in the
 *    database.
 */

/** The lease: one instance runs the job at a time. */
export interface SchedulerLease {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** What one tick did, for logs and tests. */
export interface TickReport {
  readonly skipped: boolean;
  readonly opened: number;
  readonly started: number;
  readonly launched: number;
  readonly settled: number;
}

const EMPTY: TickReport = { skipped: false, opened: 0, started: 0, launched: 0, settled: 0 };

/** The job name, and the advisory lock key that guards the lease check. */
const LEASE_NAME = "tournament_scheduler";
const LEASE_LOCK_KEY = 0x5374_5a54; // "StZT"

/** How long a lease lasts. Longer than a tick, short enough to recover quickly. */
const LEASE_SECONDS = 90;

/**
 * The production lease, held in the database.
 *
 * `acquire_scheduler_lease` takes a transaction-scoped advisory lock, checks the
 * lease row, and takes it if it is free or expired - all in one statement, which
 * is what makes two instances calling at the same instant safe.
 */
export class SupabaseSchedulerLease implements SchedulerLease {
  readonly #client: SupabaseClient;
  readonly #holder: string;
  readonly #seconds: number;
  readonly #name: string;
  readonly #lockKey: number;

  /**
   * `name` and `lockKey` let a second scheduler (the house fixtures) hold its own
   * lease with the same function: two jobs must not share one lease, or each
   * would skip its turn whenever the other happened to be running.
   */
  constructor(options?: {
    readonly client?: SupabaseClient;
    readonly holder?: string;
    readonly seconds?: number;
    readonly name?: string;
    readonly lockKey?: number;
  }) {
    this.#client = options?.client ?? supabase;
    this.#holder = options?.holder ?? defaultHolder();
    this.#seconds = options?.seconds ?? LEASE_SECONDS;
    this.#name = options?.name ?? LEASE_NAME;
    this.#lockKey = options?.lockKey ?? LEASE_LOCK_KEY;
  }

  async acquire(): Promise<boolean> {
    const result = await this.#client.rpc("acquire_scheduler_lease", {
      p_name: this.#name,
      p_holder: this.#holder,
      p_lease_seconds: this.#seconds,
      p_lock_key: this.#lockKey,
    });

    if (result.error !== null) {
      logger.error({ err: result.error }, "could not acquire the scheduler lease");
      return false;
    }

    return result.data === true;
  }

  async release(): Promise<void> {
    const result = await this.#client.rpc("release_scheduler_lease", {
      p_name: this.#name,
      p_holder: this.#holder,
    });

    if (result.error !== null) {
      logger.warn({ err: result.error }, "could not release the scheduler lease");
    }
  }
}

/** The holder id for a lease: something an operator can trace back to a process. */
export function defaultHolder(): string {
  return `${process.env["HOSTNAME"] ?? "host"}:${String(process.pid)}:${String(Date.now())}`;
}

/** An in-process lease, for tests and for a single-process development server. */
export class InMemorySchedulerLease implements SchedulerLease {
  #held = false;

  async acquire(): Promise<boolean> {
    if (this.#held) {
      return false;
    }
    this.#held = true;
    return true;
  }

  async release(): Promise<void> {
    this.#held = false;
  }
}

/** What the scheduler needs. */
export interface SchedulerDeps {
  readonly repository: TournamentRepository;
  readonly service: TournamentService;
  readonly lease: SchedulerLease;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}

/** The scheduler. */
export class TournamentScheduler {
  readonly #repository: TournamentRepository;
  readonly #service: TournamentService;
  readonly #lease: SchedulerLease;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(deps: SchedulerDeps) {
    this.#repository = deps.repository;
    this.#service = deps.service;
    this.#lease = deps.lease;
    this.#now = deps.now ?? (() => new Date());
    this.#intervalMs = deps.intervalMs ?? 10_000;
  }

  /** Runs once, under the lease. */
  async tick(): Promise<TickReport> {
    if (this.#running) {
      return { ...EMPTY, skipped: true };
    }
    this.#running = true;

    try {
      const acquired = await this.#lease.acquire();
      if (!acquired) {
        return { ...EMPTY, skipped: true };
      }

      try {
        return await this.#work();
      } finally {
        await this.#lease.release();
      }
    } finally {
      this.#running = false;
    }
  }

  /**
   * Picks up whatever was left running.
   *
   * Called on startup. It is a tick, because there is nothing a restart needs
   * that a tick does not do: everything outstanding is discoverable from the
   * database, which is the point of keeping the lifecycle there rather than in
   * memory.
   */
  async resume(): Promise<TickReport> {
    const report = await this.tick();
    logger.info({ ...report }, "tournament scheduler resumed");
    return report;
  }

  /** Starts the interval. Ten seconds by default. */
  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        logger.error({ err: error }, "scheduler tick failed");
      });
    }, this.#intervalMs);

    // Do not hold the process open just for the scheduler.
    this.#timer.unref();
    logger.info({ intervalMs: this.#intervalMs }, "tournament scheduler started");
  }

  /** Stops the interval. */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #work(): Promise<TickReport> {
    const now = this.#now();
    let opened = 0;
    let started = 0;
    let launched = 0;
    let settled = 0;

    for (const tournament of await this.#repository.list({ status: ["draft"], limit: 200 })) {
      if (!isOpenDue(tournament, now)) {
        continue;
      }
      try {
        await this.#service.open(tournament.id);
        opened += 1;
      } catch (error) {
        logger.error({ err: error, tournamentId: tournament.id }, "could not open");
      }
    }

    for (const tournament of await this.#repository.list({
      status: ["registration"],
      limit: 200,
    })) {
      if (!isStartDue(tournament, now)) {
        continue;
      }
      try {
        await this.#service.start(tournament.id);
        started += 1;
      } catch (error) {
        // A tournament cancelled for want of players lands here; that is a
        // decision, not a failure, and the next tick simply finds nothing to do.
        logger.info({ err: error, tournamentId: tournament.id }, "tournament did not start");
      }
    }

    for (const tournament of await this.#repository.list({ status: ["running"], limit: 200 })) {
      try {
        launched += await this.#service.launchDue(tournament.id);
        await this.#service.settle(tournament.id);
        settled += 1;
      } catch (error) {
        logger.error({ err: error, tournamentId: tournament.id }, "could not settle");
      }
    }

    if (opened + started + launched + settled > 0) {
      logger.info({ opened, started, launched, settled }, "scheduler tick");
    }

    return { skipped: false, opened, started, launched, settled };
  }
}

/** Registration is due when the tournament is a draft and its window has come. */
function isOpenDue(tournament: TournamentRecord, now: Date): boolean {
  if (tournament.registrationOpensAt === null) {
    return true;
  }
  return Date.parse(tournament.registrationOpensAt) <= now.getTime();
}

/** The bracket is generated at the start time, or when registration closes. */
function isStartDue(tournament: TournamentRecord, now: Date): boolean {
  const start = tournament.startsAt ?? tournament.registrationClosesAt;
  if (start === null) {
    return false;
  }
  return Date.parse(start) <= now.getTime();
}
