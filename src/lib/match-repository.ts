import type { SupabaseClient } from "@supabase/supabase-js";
import { BOT_PROFILES, type BotLevel } from "../engines/carrom/bot-config.js";
import { supabase } from "./supabase.js";
import type { MatchLogEntry } from "./match-log.js";

/**
 * Every database read and write a match needs, behind one interface.
 *
 * The room and the verification script talk only to this interface, so the whole
 * of live play can be tested against an in-memory implementation, with no
 * database and no network, and the Supabase implementation stays a thin mapping
 * layer over the tables created by the migrations.
 */

/** Where a match is in its life. Mirrors the matches.status check constraint. */
export type MatchStatus = "scheduled" | "live" | "finished" | "void";

/** A player sitting in a match. */
export interface MatchSeat {
  readonly seat: 1 | 2;
  readonly playerId: string;
  readonly displayName: string;
  readonly isBot: boolean;
  /** The bot policy id, for example carrom_master. Null for a human. */
  readonly botPolicy: string | null;
  /** The bot level, when the policy is one of the published levels. */
  readonly botLevel: BotLevel | null;
  /** The auth user id behind a human player, used to authorise a join. */
  readonly profileId: string | null;
  readonly skill: Readonly<Record<string, number>>;
}

/** The signed outcome of a finished match. */
export interface MatchResult {
  /** Seat 1 or 2, or null for a draw. */
  readonly winnerSeat: 1 | 2 | null;
  readonly winnerColour: "white" | "black" | "tie";
  readonly scores: { readonly white: number; readonly black: number };
  readonly boards: number;
  readonly shots: number;
  /** Why the match ended. */
  readonly reason: "scored" | "forfeit" | "board_limit";
  /** How much randomness the match drew from its seed. */
  readonly seedDraws: number;
}

/** A whole match, with its seats. */
export interface MatchRecord {
  readonly id: string;
  readonly game: "carrom" | "ludo";
  readonly status: MatchStatus;
  readonly seedCommit: string | null;
  readonly seedReveal: string | null;
  readonly config: Readonly<Record<string, unknown>>;
  readonly result: MatchResult | null;
  readonly resultSignature: string | null;
  readonly logHeadHash: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly seats: readonly MatchSeat[];
}

/** One seat to create: an existing player, or a bot to make. */
export type CreateMatchSeat =
  | { readonly seat: 1 | 2; readonly playerId: string }
  | {
      readonly seat: 1 | 2;
      readonly botLevel: BotLevel;
      readonly displayName?: string;
      readonly skill?: Readonly<Record<string, number>>;
    };

/** What the caller must supply to start a match. */
export interface CreateMatchInput {
  readonly seedCommit: string;
  readonly seats: readonly CreateMatchSeat[];
  readonly config?: Readonly<Record<string, unknown>>;
  readonly scheduledAt?: string | null;
}

/** Marking a match live: the commitment is recorded with the start. */
export interface MarkLiveInput {
  readonly seedCommit: string;
  readonly startedAt: string;
}

/** Finishing a match: everything a verifier needs. */
export interface FinishMatchInput {
  readonly seedReveal: string;
  readonly result: MatchResult;
  readonly resultSignature: string;
  readonly logHeadHash: string;
  readonly endedAt: string;
}

/** Raised when the store refuses a write, for example a duplicate seq. */
export class MatchRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchRepositoryError";
  }
}

/** Everything the room, the API and the verifier need from storage. */
export interface MatchRepository {
  create(input: CreateMatchInput): Promise<MatchRecord>;
  get(matchId: string): Promise<MatchRecord | null>;
  markLive(matchId: string, input: MarkLiveInput): Promise<void>;
  appendEvents(matchId: string, entries: readonly MatchLogEntry[]): Promise<void>;
  finish(matchId: string, input: FinishMatchInput): Promise<void>;
  listEvents(matchId: string): Promise<MatchLogEntry[]>;
}

// ---------------------------------------------------------------------------
// In memory: the implementation every test runs against
// ---------------------------------------------------------------------------

interface MemoryPlayer {
  id: string;
  displayName: string;
  isBot: boolean;
  botPolicy: string | null;
  botLevel: BotLevel | null;
  profileId: string | null;
  skill: Record<string, number>;
}

/**
 * An in-memory match store, with the same rules as the database: append-only
 * events with contiguous sequence numbers, and no going back from finished.
 */
export class InMemoryMatchRepository implements MatchRepository {
  readonly #matches = new Map<string, MatchRecord>();
  readonly #events = new Map<string, MatchLogEntry[]>();
  #nextMatch = 1;
  #nextPlayer = 1;

  /** Creates a match with two seats. Bot seats get a bot player row. */
  async create(input: CreateMatchInput): Promise<MatchRecord> {
    const id = `match_${this.#nextMatch}`;
    this.#nextMatch += 1;

    const seats: MatchSeat[] = input.seats.map((seat) => {
      if ("playerId" in seat) {
        return {
          seat: seat.seat,
          playerId: seat.playerId,
          displayName: `Player ${seat.playerId}`,
          isBot: false,
          botPolicy: null,
          botLevel: null,
          profileId: seat.playerId,
          skill: {},
        };
      }

      const player = this.createBot(seat.botLevel, seat.displayName, seat.skill);
      return {
        seat: seat.seat,
        playerId: player.id,
        displayName: player.displayName,
        isBot: true,
        botPolicy: player.botPolicy,
        botLevel: player.botLevel,
        profileId: null,
        skill: player.skill,
      };
    });

    const match: MatchRecord = {
      id,
      game: "carrom",
      status: "scheduled",
      seedCommit: input.seedCommit,
      seedReveal: null,
      config: input.config ?? {},
      result: null,
      resultSignature: null,
      logHeadHash: null,
      startedAt: null,
      endedAt: null,
      seats,
    };

    this.#matches.set(id, match);
    this.#events.set(id, []);
    return match;
  }

  /** A seat that is not a bot: lets a test seat a named player. */
  async addHumanPlayer(profileId: string, displayName: string): Promise<string> {
    this.#nextPlayer += 1;
    return `${profileId}:${displayName}:${this.#nextPlayer}`;
  }

  private createBot(
    level: BotLevel,
    displayName: string | undefined,
    skill: Readonly<Record<string, number>> | undefined,
  ): MemoryPlayer {
    const profile = BOT_PROFILES[level];
    const id = `bot_${level}_${this.#nextPlayer}`;
    this.#nextPlayer += 1;

    return {
      id,
      displayName: displayName ?? profile.displayName,
      isBot: true,
      botPolicy: profile.policy,
      botLevel: level,
      profileId: null,
      skill: { ...(skill ?? {}) },
    };
  }

  async get(matchId: string): Promise<MatchRecord | null> {
    return this.#matches.get(matchId) ?? null;
  }

  async markLive(matchId: string, input: MarkLiveInput): Promise<void> {
    const match = this.require(matchId);
    if (match.status === "finished" || match.status === "void") {
      throw new MatchRepositoryError(`match ${matchId} is already ${match.status}`);
    }

    this.#matches.set(matchId, {
      ...match,
      status: "live",
      seedCommit: input.seedCommit,
      startedAt: input.startedAt,
    });
  }

  async appendEvents(matchId: string, entries: readonly MatchLogEntry[]): Promise<void> {
    const match = this.require(matchId);
    if (match.status === "finished" || match.status === "void") {
      throw new MatchRepositoryError(`match ${matchId} is ${match.status}, the log is closed`);
    }

    const existing = this.#events.get(matchId) ?? [];
    const seen = new Set(existing.map((entry) => entry.seq));

    for (const entry of entries) {
      if (seen.has(entry.seq)) {
        throw new MatchRepositoryError(`duplicate seq ${entry.seq} for match ${matchId}`);
      }
      seen.add(entry.seq);
    }

    this.#events.set(matchId, [...existing, ...entries]);
  }

  async finish(matchId: string, input: FinishMatchInput): Promise<void> {
    const match = this.require(matchId);
    if (match.status !== "live") {
      throw new MatchRepositoryError(`match ${matchId} is ${match.status}, not live`);
    }

    this.#matches.set(matchId, {
      ...match,
      status: "finished",
      seedReveal: input.seedReveal,
      result: input.result,
      resultSignature: input.resultSignature,
      logHeadHash: input.logHeadHash,
      endedAt: input.endedAt,
    });
  }

  async listEvents(matchId: string): Promise<MatchLogEntry[]> {
    return [...(this.#events.get(matchId) ?? [])];
  }

  private require(matchId: string): MatchRecord {
    const match = this.#matches.get(matchId);
    if (match === undefined) {
      throw new MatchRepositoryError(`unknown match ${matchId}`);
    }
    return match;
  }
}

// ---------------------------------------------------------------------------
// Supabase: the production store
// ---------------------------------------------------------------------------

interface MatchRow {
  id: string;
  game: string;
  status: string;
  seed_commit: string | null;
  seed_reveal: string | null;
  config: unknown;
  result: unknown;
  result_signature: string | null;
  log_head_hash: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface SeatRow {
  seat: number;
  player_id: string;
  players: {
    display_name: string;
    kind: string;
    bot_policy: string | null;
    profile_id: string | null;
    skill: unknown;
  } | null;
}

interface EventRow {
  seq: number;
  type: string;
  payload: unknown;
  prev_hash: string | null;
  hash: string | null;
}

/** The match store backed by the tables in /supabase/migrations. */
export class SupabaseMatchRepository implements MatchRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async create(input: CreateMatchInput): Promise<MatchRecord> {
    const seatRows: Array<{ seat: number; player_id: string }> = [];

    for (const seat of input.seats) {
      if ("playerId" in seat) {
        seatRows.push({ seat: seat.seat, player_id: seat.playerId });
        continue;
      }

      const profile = BOT_PROFILES[seat.botLevel];
      const inserted = await this.#client
        .from("players")
        .insert({
          kind: "bot",
          display_name: seat.displayName ?? profile.displayName,
          bot_policy: profile.policy,
          skill: seat.skill ?? {},
        })
        .select("id")
        .single<{ id: string }>();

      if (inserted.error !== null || inserted.data === null) {
        throw new MatchRepositoryError(
          `could not create the bot player: ${inserted.error?.message ?? "no row returned"}`,
        );
      }

      seatRows.push({ seat: seat.seat, player_id: inserted.data.id });
    }

    const matchInsert = await this.#client
      .from("matches")
      .insert({
        game: "carrom",
        status: "scheduled",
        seed_commit: input.seedCommit,
        config: input.config ?? {},
        scheduled_at: input.scheduledAt ?? null,
      })
      .select("id")
      .single<{ id: string }>();

    if (matchInsert.error !== null || matchInsert.data === null) {
      throw new MatchRepositoryError(
        `could not create the match: ${matchInsert.error?.message ?? "no row returned"}`,
      );
    }

    const matchId = matchInsert.data.id;
    const seatInsert = await this.#client
      .from("match_players")
      .insert(seatRows.map((row) => ({ ...row, match_id: matchId })));

    if (seatInsert.error !== null) {
      throw new MatchRepositoryError(`could not seat the players: ${seatInsert.error.message}`);
    }

    const created = await this.get(matchId);
    if (created === null) {
      throw new MatchRepositoryError(`match ${matchId} vanished after it was created`);
    }
    return created;
  }

  async get(matchId: string): Promise<MatchRecord | null> {
    const matchRow = await this.#client
      .from("matches")
      .select(
        "id, game, status, seed_commit, seed_reveal, config, result, result_signature, log_head_hash, started_at, ended_at",
      )
      .eq("id", matchId)
      .maybeSingle<MatchRow>();

    if (matchRow.error !== null) {
      throw new MatchRepositoryError(`could not read the match: ${matchRow.error.message}`);
    }
    if (matchRow.data === null) {
      return null;
    }

    const seatResult = await this.#client
      .from("match_players")
      .select("seat, player_id, players (display_name, kind, bot_policy, profile_id, skill)")
      .eq("match_id", matchId)
      .order("seat")
      .returns<SeatRow[]>();

    if (seatResult.error !== null) {
      throw new MatchRepositoryError(`could not read the match seats: ${seatResult.error.message}`);
    }

    return toMatchRecord(matchRow.data, seatResult.data ?? []);
  }

  async markLive(matchId: string, input: MarkLiveInput): Promise<void> {
    const result = await this.#client
      .from("matches")
      .update({ status: "live", seed_commit: input.seedCommit, started_at: input.startedAt })
      .eq("id", matchId)
      .in("status", ["scheduled", "live"]);

    if (result.error !== null) {
      throw new MatchRepositoryError(`could not start the match: ${result.error.message}`);
    }
  }

  async appendEvents(matchId: string, entries: readonly MatchLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const result = await this.#client.from("match_events").insert(
      entries.map((entry) => ({
        match_id: matchId,
        seq: entry.seq,
        type: entry.type,
        payload: entry.payload,
        prev_hash: entry.prevHash,
        hash: entry.hash,
      })),
    );

    if (result.error !== null) {
      throw new MatchRepositoryError(`could not append to the match log: ${result.error.message}`);
    }
  }

  async finish(matchId: string, input: FinishMatchInput): Promise<void> {
    const result = await this.#client
      .from("matches")
      .update({
        status: "finished",
        seed_reveal: input.seedReveal,
        result: input.result,
        result_signature: input.resultSignature,
        log_head_hash: input.logHeadHash,
        ended_at: input.endedAt,
      })
      .eq("id", matchId)
      .eq("status", "live");

    if (result.error !== null) {
      throw new MatchRepositoryError(`could not finish the match: ${result.error.message}`);
    }
  }

  async listEvents(matchId: string): Promise<MatchLogEntry[]> {
    const result = await this.#client
      .from("match_events")
      .select("seq, type, payload, prev_hash, hash")
      .eq("match_id", matchId)
      .order("seq", { ascending: true })
      .returns<EventRow[]>();

    if (result.error !== null) {
      throw new MatchRepositoryError(`could not read the match log: ${result.error.message}`);
    }

    return (result.data ?? []).map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: isRecord(row.payload) ? row.payload : {},
      prevHash: row.prev_hash ?? "",
      hash: row.hash ?? "",
    }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maps the two table shapes onto the domain record, refusing anything malformed. */
export function toMatchRecord(row: MatchRow, seats: readonly SeatRow[]): MatchRecord {
  const mapped: MatchSeat[] = seats.map((seat) => {
    const player = seat.players;
    const isBot = player?.kind === "bot";
    const botPolicy = player?.bot_policy ?? null;

    return {
      seat: seat.seat === 2 ? 2 : 1,
      playerId: seat.player_id,
      displayName: player?.display_name ?? seat.player_id,
      isBot,
      botPolicy,
      botLevel: botPolicy === null ? null : levelForPolicy(botPolicy),
      profileId: player?.profile_id ?? null,
      skill: isRecord(player?.skill) ? numericSkill(player.skill) : {},
    };
  });

  return {
    id: row.id,
    game: row.game === "ludo" ? "ludo" : "carrom",
    status: toStatus(row.status),
    seedCommit: row.seed_commit,
    seedReveal: row.seed_reveal,
    config: isRecord(row.config) ? row.config : {},
    result: isMatchResult(row.result) ? row.result : null,
    resultSignature: row.result_signature,
    logHeadHash: row.log_head_hash,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    seats: mapped,
  };
}

function toStatus(value: string): MatchStatus {
  switch (value) {
    case "live":
    case "finished":
    case "void":
      return value;
    default:
      return "scheduled";
  }
}

/** Reads back a level from a stored policy id, for example carrom_master. */
export function levelForPolicy(policy: string): BotLevel | null {
  for (const profile of Object.values(BOT_PROFILES)) {
    if (profile.policy === policy) {
      return profile.level;
    }
  }
  return null;
}

function numericSkill(skill: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(skill)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    }
  }
  return result;
}

/** Narrows an untyped jsonb column to a match result. */
export function isMatchResult(value: unknown): value is MatchResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["shots"] === "number" &&
    typeof value["boards"] === "number" &&
    isRecord(value["scores"]) &&
    typeof value["scores"]["white"] === "number" &&
    typeof value["scores"]["black"] === "number"
  );
}
