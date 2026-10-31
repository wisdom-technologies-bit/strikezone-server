import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { FixtureGame, StoredFixture } from "./types.js";

/**
 * What the fixture scheduler needs from storage.
 *
 * The fixtures are match rows, so there is no fixtures table: what a fixture *is*
 * lives in `matches` and `match_players`, and this interface is the few questions
 * the scheduler asks of them. The one thing that needs a row of its own is the
 * pause switch, which has to survive a restart and mean the same to both
 * instances.
 *
 * A house fixture is a match with no tournament whose every seat is a bot. That
 * definition needs no column to be added, and stays true for a match created by
 * an earlier version of this code.
 */
export interface FixturesRepository {
  /** Scheduled fixtures, soonest first. */
  listUpcoming(limit: number): Promise<readonly StoredFixture[]>;
  /** Fixtures in play right now. */
  listRunning(): Promise<readonly StoredFixture[]>;
  /** Bot-only matches that finished recently, for the hand-over sweep. */
  listRecentlyFinished(sinceIso: string, limit: number): Promise<readonly StoredFixture[]>;
  /** The pause switch. False when it has never been set. */
  isPaused(): Promise<boolean>;
  setPaused(paused: boolean, actor: string | null, at: string): Promise<void>;
}

const FIXTURE_COLUMNS = "id, game, status, scheduled_at, seed_commit, started_at";

interface FixtureRow {
  readonly id: string;
  readonly game: FixtureGame;
  readonly status: "scheduled" | "live" | "finished" | "void";
  readonly scheduled_at: string | null;
  readonly seed_commit: string | null;
  readonly started_at: string | null;
}

function toFixture(row: FixtureRow): StoredFixture {
  return {
    id: row.id,
    game: row.game,
    status: row.status,
    scheduledAt: row.scheduled_at,
    seedCommit: row.seed_commit,
    startedAt: row.started_at,
  };
}

/**
 * The Supabase implementation.
 *
 * A missing `fixture_controller` table is not fatal: the migration may not have
 * been run on a project that has not switched fixtures on. A pause is then read
 * as "not paused", which is the state a project without the table must be in for
 * fixtures to work at all, and the first attempt to write one says so in the log.
 */
export class SupabaseFixturesRepository implements FixturesRepository {
  readonly #client: SupabaseClient;
  #controllerMissing = false;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async listUpcoming(limit: number): Promise<readonly StoredFixture[]> {
    return this.#collect(
      this.#client
        .from("matches")
        .select(`${FIXTURE_COLUMNS}, ended_at`)
        .eq("status", "scheduled")
        .is("tournament_id", null)
        .order("scheduled_at", { ascending: true, nullsFirst: false })
        .limit(limit),
    );
  }

  async listRunning(): Promise<readonly StoredFixture[]> {
    return this.#collect(
      this.#client
        .from("matches")
        .select(`${FIXTURE_COLUMNS}, ended_at`)
        .eq("status", "live")
        .is("tournament_id", null)
        .order("started_at", { ascending: true })
        .limit(32),
    );
  }

  async listRecentlyFinished(sinceIso: string, limit: number): Promise<readonly StoredFixture[]> {
    return this.#collect(
      this.#client
        .from("matches")
        .select(`${FIXTURE_COLUMNS}, ended_at`)
        .eq("status", "finished")
        .is("tournament_id", null)
        .gte("ended_at", sinceIso)
        .order("ended_at", { ascending: false })
        .limit(limit),
    );
  }

  /** Awaits a query, keeps the bot-only rows, and maps them to the fixture shape. */
  async #collect(query: Query): Promise<readonly StoredFixture[]> {
    const { data, error } = await query;
    if (error !== null) {
      throw new Error(`could not read fixtures: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as readonly FixtureRow[];
    if (rows.length === 0) {
      return [];
    }

    const bots = await this.#allBotMatches(rows.map((row) => row.id));
    return rows.filter((row) => bots.has(row.id)).map(toFixture);
  }

  /** The ids whose every seat is a bot, out of the candidates given. */
  async #allBotMatches(matchIds: readonly string[]): Promise<Set<string>> {
    const withSeats = new Set<string>();
    const withHumans = new Set<string>();

    const { data, error } = await this.#client
      .from("match_players")
      .select("match_id, players(kind)")
      .in("match_id", [...matchIds]);

    if (error !== null) {
      throw new Error(`could not read the seats: ${error.message}`);
    }

    for (const row of (data ?? []) as unknown as readonly {
      match_id: string;
      players: { kind: string } | null;
    }[]) {
      withSeats.add(row.match_id);
      if (row.players?.kind !== "bot") {
        withHumans.add(row.match_id);
      }
    }

    return new Set([...withSeats].filter((id) => !withHumans.has(id)));
  }

  async isPaused(): Promise<boolean> {
    if (this.#controllerMissing) {
      return false;
    }

    const { data, error } = await this.#client
      .from("fixture_controller")
      .select("paused")
      .eq("id", 1)
      .maybeSingle<{ paused: boolean }>();

    if (error !== null) {
      // PGRST205 is "no such table": the migration has not been run here.
      if (error.code === "PGRST205") {
        this.#controllerMissing = true;
        logger.warn(
          "fixture_controller is missing: run migration 012. Fixtures run unpaused until then",
        );
        return false;
      }
      throw new Error(`could not read the fixture controller: ${error.message}`);
    }

    return data?.paused ?? false;
  }

  async setPaused(paused: boolean, actor: string | null, at: string): Promise<void> {
    const { error } = await this.#client
      .from("fixture_controller")
      .upsert({ id: 1, paused, updated_by: actor, updated_at: at }, { onConflict: "id" });

    if (error !== null) {
      throw new Error(`could not set the fixture pause: ${error.message}`);
    }
    this.#controllerMissing = false;
  }
}

/** The shape a Supabase query is once it is awaited, without naming PostgREST's generics. */
interface QueryResult {
  readonly data: unknown;
  readonly error: { readonly message: string } | null;
}

/** A query that has not been awaited yet. */
type Query = PromiseLike<QueryResult>;

/** An in-memory implementation, used by every fixture test. */
export class InMemoryFixturesRepository implements FixturesRepository {
  #upcoming: StoredFixture[] = [];
  #running: StoredFixture[] = [];
  #finished: StoredFixture[] = [];
  #paused = false;

  /** Replaces what the scheduler will read, as the store would return it. */
  setState(state: {
    readonly upcoming?: readonly StoredFixture[];
    readonly running?: readonly StoredFixture[];
    readonly finished?: readonly StoredFixture[];
  }): void {
    if (state.upcoming !== undefined) this.#upcoming = [...state.upcoming];
    if (state.running !== undefined) this.#running = [...state.running];
    if (state.finished !== undefined) this.#finished = [...state.finished];
  }

  async listUpcoming(limit: number): Promise<readonly StoredFixture[]> {
    return [...this.#upcoming]
      .sort((left, right) => (left.scheduledAt ?? "").localeCompare(right.scheduledAt ?? ""))
      .slice(0, limit);
  }

  listRunning(): Promise<readonly StoredFixture[]> {
    return Promise.resolve([...this.#running]);
  }

  listRecentlyFinished(_sinceIso: string, limit: number): Promise<readonly StoredFixture[]> {
    return Promise.resolve(this.#finished.slice(0, limit));
  }

  isPaused(): Promise<boolean> {
    return Promise.resolve(this.#paused);
  }

  setPaused(paused: boolean): Promise<void> {
    this.#paused = paused;
    return Promise.resolve();
  }
}
