import type { SupabaseClient } from "@supabase/supabase-js";
import { BOT_PROFILES, type BotLevel } from "../engines/carrom/bot-config.js";
import { supabase } from "../lib/supabase.js";
import { levelForPolicy } from "../lib/match-repository.js";
import {
  tournamentConfigSchema,
  type BracketPositionRecord,
  type EntryRecord,
  type EntryStatus,
  type PlayerRecord,
  type PositionStatus,
  type TournamentConfig,
  type TournamentGame,
  type TournamentPayoutRecord,
  type TournamentRecord,
  type TournamentStatus,
} from "./types.js";

/**
 * Every database read and write a tournament needs, behind one interface.
 *
 * The tournament service talks only to this interface, so the whole lifecycle -
 * registration, the bracket, advancement, refunds, restart recovery - runs in
 * tests against an in-memory implementation, and the Supabase implementation
 * stays a thin mapping over the tables from the migrations.
 *
 * Two methods do real work rather than just mapping, and both are about racing:
 * {@link TournamentRepository.claimPosition} and
 * {@link TournamentRepository.completePosition} are conditional updates, so two
 * servers (or two ticks of one scheduler) cannot launch the same match twice or
 * decide the same position twice.
 */

/** Everything needed to create a tournament. */
export interface CreateTournamentInput {
  readonly name: string;
  readonly game: TournamentGame;
  readonly config: TournamentConfig;
  readonly currency: string;
  readonly status: TournamentStatus;
}

/** The fields a tournament may have changed. */
export interface TournamentPatch {
  readonly status?: TournamentStatus;
  readonly prizePoolMinor?: number;
  readonly championPlayerId?: string | null;
  readonly payouts?: readonly TournamentPayoutRecord[] | null;
  readonly finishedAt?: string | null;
  readonly cancelledAt?: string | null;
}

/** A new entry. */
export interface NewEntry {
  readonly tournamentId: string;
  readonly playerId: string;
  readonly entryFeeMinor: number;
  readonly seed?: number | null;
}

/** The fields an entry may have changed. */
export interface EntryPatch {
  readonly status?: EntryStatus;
  readonly seed?: number | null;
  readonly withdrawnAt?: string | null;
  readonly eliminatedRound?: number | null;
}

/** A bracket position to insert. */
export interface NewPosition {
  readonly round: number;
  readonly slot: number;
  readonly winnerToSlot: number | null;
  readonly seat1PlayerId: string | null;
  readonly seat2PlayerId: string | null;
  readonly status: PositionStatus;
  readonly dueAt: string | null;
}

/** The fields a bracket position may have changed. */
export interface PositionPatch {
  readonly seat1PlayerId?: string | null;
  readonly seat2PlayerId?: string | null;
  readonly status?: PositionStatus;
  readonly dueAt?: string | null;
  readonly matchId?: string | null;
  readonly points?: { readonly seat1: number; readonly seat2: number } | null;
  /** Set to null to release a launch claim whose room could not be opened. */
  readonly launchedAt?: string | null;
}

/** A decided position. */
export interface PositionResult {
  readonly winnerPlayerId: string;
  readonly loserPlayerId: string | null;
  readonly isWalkover: boolean;
  readonly points?: { readonly seat1: number; readonly seat2: number } | null;
}

/** Raised when the store refuses a write. */
export class TournamentRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TournamentRepositoryError";
  }
}

/** What a tournament is stored in, and everything the service reads. */
export interface TournamentRepository {
  create(input: CreateTournamentInput): Promise<TournamentRecord>;
  get(tournamentId: string): Promise<TournamentRecord | null>;
  list(filter?: {
    readonly status?: readonly TournamentStatus[];
    readonly game?: TournamentGame;
    readonly limit?: number;
  }): Promise<TournamentRecord[]>;
  update(tournamentId: string, patch: TournamentPatch): Promise<TournamentRecord>;
  /**
   * Moves a tournament from one status to another, atomically. Null means it was
   * not in `from` any more, so the caller lost the race and must not proceed.
   * This is what stops two servers generating the same bracket twice.
   */
  transition(
    tournamentId: string,
    from: TournamentStatus,
    to: TournamentStatus,
  ): Promise<TournamentRecord | null>;

  listEntries(tournamentId: string): Promise<EntryRecord[]>;
  getEntry(tournamentId: string, playerId: string): Promise<EntryRecord | null>;
  addEntry(input: NewEntry): Promise<EntryRecord>;
  updateEntry(tournamentId: string, playerId: string, patch: EntryPatch): Promise<void>;

  /** The player row behind an auth user, created on first registration. */
  playerForProfile(profileId: string, displayName: string): Promise<PlayerRecord>;
  /** A labelled bot, with the level it plays at. */
  createBotPlayer(level: BotLevel, displayName?: string): Promise<PlayerRecord>;
  getPlayer(playerId: string): Promise<PlayerRecord | null>;

  insertPositions(tournamentId: string, positions: readonly NewPosition[]): Promise<void>;
  listPositions(tournamentId: string): Promise<BracketPositionRecord[]>;
  getPosition(positionId: string): Promise<BracketPositionRecord | null>;
  updatePosition(positionId: string, patch: PositionPatch): Promise<BracketPositionRecord>;
  /** Takes the launch claim. Null means another server got there first. */
  claimPosition(positionId: string, at: string): Promise<BracketPositionRecord | null>;
  /** Records a decision. Null means the position already had one. */
  completePosition(
    positionId: string,
    result: PositionResult,
    at: string,
  ): Promise<BracketPositionRecord | null>;
}

// ---------------------------------------------------------------------------
// In memory: the implementation every test runs against
// ---------------------------------------------------------------------------

interface MemoryTournament extends TournamentRecord {
  prizePoolMinor: number;
}

/**
 * An in-memory tournament store.
 *
 * It enforces the rules that matter to correctness: one entry per player per
 * tournament, seeds unique inside a tournament, and round plus slot unique so a
 * bracket position cannot be created twice.
 */
export class InMemoryTournamentRepository implements TournamentRepository {
  readonly #tournaments = new Map<string, MemoryTournament>();
  readonly #entries = new Map<string, Map<string, EntryRecord>>();
  readonly #positions = new Map<string, BracketPositionRecord>();
  readonly #players = new Map<string, PlayerRecord>();
  #nextTournament = 1;
  #nextPosition = 1;
  #nextPlayer = 1;

  async create(input: CreateTournamentInput): Promise<TournamentRecord> {
    const id = `tournament_${this.#nextTournament}`;
    this.#nextTournament += 1;

    const { config } = input;
    const record: MemoryTournament = {
      id,
      game: input.game,
      name: input.name,
      format: config.format,
      status: input.status,
      entryFeeMinor: config.entryFeeMinor,
      prizePoolMinor: 0,
      minPlayers: config.minPlayers,
      maxPlayers: config.maxPlayers,
      currency: input.currency,
      config,
      registrationOpensAt: config.registrationOpensAt ?? null,
      registrationClosesAt: config.registrationClosesAt ?? null,
      startsAt: config.startsAt ?? null,
      championPlayerId: null,
      payouts: null,
      finishedAt: null,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
    };

    this.#tournaments.set(id, record);
    this.#entries.set(id, new Map());
    return record;
  }

  async get(tournamentId: string): Promise<TournamentRecord | null> {
    return this.#tournaments.get(tournamentId) ?? null;
  }

  async list(filter?: {
    readonly status?: readonly TournamentStatus[];
    readonly game?: TournamentGame;
    readonly limit?: number;
  }): Promise<TournamentRecord[]> {
    let found = [...this.#tournaments.values()];

    if (filter?.status !== undefined) {
      const allowed = new Set(filter.status);
      found = found.filter((tournament) => allowed.has(tournament.status));
    }
    if (filter?.game !== undefined) {
      found = found.filter((tournament) => tournament.game === filter.game);
    }

    found.sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
    return found.slice(0, filter?.limit ?? 100);
  }

  async update(tournamentId: string, patch: TournamentPatch): Promise<TournamentRecord> {
    const existing = this.#require(tournamentId);
    const updated: MemoryTournament = {
      ...existing,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.prizePoolMinor === undefined ? {} : { prizePoolMinor: patch.prizePoolMinor }),
      ...(patch.championPlayerId === undefined ? {} : { championPlayerId: patch.championPlayerId }),
      ...(patch.payouts === undefined ? {} : { payouts: patch.payouts }),
      ...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
      ...(patch.cancelledAt === undefined ? {} : { cancelledAt: patch.cancelledAt }),
    };
    this.#tournaments.set(tournamentId, updated);
    return updated;
  }

  async transition(
    tournamentId: string,
    from: TournamentStatus,
    to: TournamentStatus,
  ): Promise<TournamentRecord | null> {
    const existing = this.#tournaments.get(tournamentId);
    if (existing === undefined || existing.status !== from) {
      return null;
    }
    const updated: MemoryTournament = { ...existing, status: to };
    this.#tournaments.set(tournamentId, updated);
    return updated;
  }

  async listEntries(tournamentId: string): Promise<EntryRecord[]> {
    return [...(this.#entries.get(tournamentId)?.values() ?? [])];
  }

  async getEntry(tournamentId: string, playerId: string): Promise<EntryRecord | null> {
    return this.#entries.get(tournamentId)?.get(playerId) ?? null;
  }

  async addEntry(input: NewEntry): Promise<EntryRecord> {
    const bucket = this.#entries.get(input.tournamentId);
    if (bucket === undefined) {
      throw new TournamentRepositoryError(`unknown tournament ${input.tournamentId}`);
    }
    if (bucket.has(input.playerId)) {
      throw new TournamentRepositoryError(`${input.playerId} is already entered`);
    }

    const player = this.#players.get(input.playerId);
    const entry: EntryRecord = {
      tournamentId: input.tournamentId,
      playerId: input.playerId,
      seed: input.seed ?? null,
      status: "registered",
      entryFeeMinor: input.entryFeeMinor,
      registeredAt: new Date().toISOString(),
      withdrawnAt: null,
      eliminatedRound: null,
      isBot: player?.isBot ?? false,
      displayName: player?.displayName ?? input.playerId,
      rating: player?.rating ?? 1000,
    };

    bucket.set(input.playerId, entry);
    return entry;
  }

  async updateEntry(tournamentId: string, playerId: string, patch: EntryPatch): Promise<void> {
    const bucket = this.#entries.get(tournamentId);
    const existing = bucket?.get(playerId);
    if (bucket === undefined || existing === undefined) {
      throw new TournamentRepositoryError(`no entry for ${playerId} in ${tournamentId}`);
    }

    const updated: EntryRecord = {
      ...existing,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.seed === undefined ? {} : { seed: patch.seed }),
      ...(patch.withdrawnAt === undefined ? {} : { withdrawnAt: patch.withdrawnAt }),
      ...(patch.eliminatedRound === undefined ? {} : { eliminatedRound: patch.eliminatedRound }),
    };
    bucket.set(playerId, updated);
  }

  async playerForProfile(profileId: string, displayName: string): Promise<PlayerRecord> {
    for (const player of this.#players.values()) {
      if (player.profileId === profileId) {
        return player;
      }
    }

    this.#nextPlayer += 1;
    const player: PlayerRecord = {
      id: `player_${String(this.#nextPlayer)}`,
      displayName,
      isBot: false,
      botLevel: null,
      botPolicy: null,
      profileId,
      rating: 1000,
    };
    this.#players.set(player.id, player);
    return player;
  }

  async createBotPlayer(level: BotLevel, displayName?: string): Promise<PlayerRecord> {
    this.#nextPlayer += 1;
    const profile = BOT_PROFILES[level];
    const player: PlayerRecord = {
      id: `bot_${level}_${String(this.#nextPlayer)}`,
      displayName: displayName ?? `${profile.displayName} (bot)`,
      isBot: true,
      botLevel: level,
      botPolicy: profile.policy,
      profileId: null,
      rating: botRating(level),
    };
    this.#players.set(player.id, player);
    return player;
  }

  async getPlayer(playerId: string): Promise<PlayerRecord | null> {
    return this.#players.get(playerId) ?? null;
  }

  async insertPositions(tournamentId: string, positions: readonly NewPosition[]): Promise<void> {
    // The whole bracket or none of it: a half-written bracket is worse than no
    // bracket, because nothing later can tell which positions are missing.
    const taken = new Set(
      [...this.#positions.values()]
        .filter((existing) => existing.tournamentId === tournamentId)
        .map((existing) => `${String(existing.round)}:${String(existing.slot)}`),
    );

    for (const position of positions) {
      const key = `${String(position.round)}:${String(position.slot)}`;
      if (taken.has(key)) {
        throw new TournamentRepositoryError(`position ${key} already exists`);
      }
      taken.add(key);
    }

    for (const position of positions) {
      const id = `position_${String(this.#nextPosition)}`;
      this.#nextPosition += 1;

      this.#positions.set(id, {
        id,
        tournamentId,
        round: position.round,
        slot: position.slot,
        winnerToSlot: position.winnerToSlot,
        seat1PlayerId: position.seat1PlayerId,
        seat2PlayerId: position.seat2PlayerId,
        status: position.status,
        dueAt: position.dueAt,
        launchedAt: null,
        completedAt: null,
        winnerPlayerId: null,
        loserPlayerId: null,
        matchId: null,
        isWalkover: false,
        points: null,
      });
    }
  }

  async listPositions(tournamentId: string): Promise<BracketPositionRecord[]> {
    return [...this.#positions.values()]
      .filter((position) => position.tournamentId === tournamentId)
      .sort((left, right) => left.round - right.round || left.slot - right.slot);
  }

  async getPosition(positionId: string): Promise<BracketPositionRecord | null> {
    return this.#positions.get(positionId) ?? null;
  }

  async updatePosition(positionId: string, patch: PositionPatch): Promise<BracketPositionRecord> {
    const existing = this.#positions.get(positionId);
    if (existing === undefined) {
      throw new TournamentRepositoryError(`unknown position ${positionId}`);
    }

    const updated: BracketPositionRecord = {
      ...existing,
      ...(patch.seat1PlayerId === undefined ? {} : { seat1PlayerId: patch.seat1PlayerId }),
      ...(patch.seat2PlayerId === undefined ? {} : { seat2PlayerId: patch.seat2PlayerId }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.dueAt === undefined ? {} : { dueAt: patch.dueAt }),
      ...(patch.matchId === undefined ? {} : { matchId: patch.matchId }),
      ...(patch.points === undefined ? {} : { points: patch.points }),
      ...(patch.launchedAt === undefined ? {} : { launchedAt: patch.launchedAt }),
    };
    this.#positions.set(positionId, updated);
    return updated;
  }

  async claimPosition(positionId: string, at: string): Promise<BracketPositionRecord | null> {
    const existing = this.#positions.get(positionId);
    if (existing === undefined) {
      throw new TournamentRepositoryError(`unknown position ${positionId}`);
    }
    if (existing.launchedAt !== null) {
      return null;
    }

    const claimed: BracketPositionRecord = { ...existing, launchedAt: at, status: "live" };
    this.#positions.set(positionId, claimed);
    return claimed;
  }

  async completePosition(
    positionId: string,
    result: PositionResult,
    at: string,
  ): Promise<BracketPositionRecord | null> {
    const existing = this.#positions.get(positionId);
    if (existing === undefined) {
      throw new TournamentRepositoryError(`unknown position ${positionId}`);
    }
    if (existing.winnerPlayerId !== null) {
      return null;
    }

    const completed: BracketPositionRecord = {
      ...existing,
      status: result.isWalkover ? "walkover" : "finished",
      winnerPlayerId: result.winnerPlayerId,
      loserPlayerId: result.loserPlayerId,
      completedAt: at,
      isWalkover: result.isWalkover,
      points: result.points ?? null,
    };
    this.#positions.set(positionId, completed);
    return completed;
  }

  /** A seat from a named human player, for tests that do not go through Supabase. */
  async addHumanPlayer(displayName: string, rating = 1000): Promise<PlayerRecord> {
    this.#nextPlayer += 1;
    const player: PlayerRecord = {
      id: `player_${String(this.#nextPlayer)}`,
      displayName,
      isBot: false,
      botLevel: null,
      botPolicy: null,
      profileId: `profile_${String(this.#nextPlayer)}`,
      rating,
    };
    this.#players.set(player.id, player);
    return player;
  }

  #require(tournamentId: string): MemoryTournament {
    const found = this.#tournaments.get(tournamentId);
    if (found === undefined) {
      throw new TournamentRepositoryError(`unknown tournament ${tournamentId}`);
    }
    return found;
  }
}

/** The rating a bot is seeded with, so bots do not always meet the top seed. */
function botRating(level: BotLevel): number {
  switch (level) {
    case "master":
      return 1600;
    case "club":
      return 1200;
    default:
      return 800;
  }
}

// ---------------------------------------------------------------------------
// Supabase: the production store
// ---------------------------------------------------------------------------

interface TournamentRow {
  id: string;
  game: string;
  name: string;
  format: string;
  status: string;
  entry_fee_minor: number | string;
  prize_pool_minor: number | string;
  min_players: number | null;
  max_players: number | null;
  currency: string | null;
  config: unknown;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  starts_at: string | null;
  champion_player_id: string | null;
  payouts: unknown;
  finished_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

interface EntryRow {
  tournament_id: string;
  player_id: string;
  seed: number | null;
  status: string;
  entry_fee_minor: number | string | null;
  registered_at: string | null;
  withdrawn_at: string | null;
  eliminated_round: number | null;
  players: {
    display_name: string;
    kind: string;
    skill: unknown;
  } | null;
}

interface PositionRow {
  id: string;
  tournament_id: string;
  round: number;
  slot: number;
  winner_to_slot: number | null;
  seat_1_player_id: string | null;
  seat_2_player_id: string | null;
  status: string;
  due_at: string | null;
  launched_at: string | null;
  completed_at: string | null;
  winner_player_id: string | null;
  loser_player_id: string | null;
  match_id: string | null;
  is_walkover: boolean;
  points: unknown;
}

interface PlayerRow {
  id: string;
  display_name: string;
  kind: string;
  bot_policy: string | null;
  profile_id: string | null;
  skill: unknown;
}

/** The tournament store backed by the tables in /supabase/migrations. */
export class SupabaseTournamentRepository implements TournamentRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async create(input: CreateTournamentInput): Promise<TournamentRecord> {
    const { config } = input;
    const inserted = await this.#client
      .from("tournaments")
      .insert({
        game: input.game,
        name: input.name,
        format: config.format,
        status: input.status,
        entry_fee_minor: config.entryFeeMinor,
        prize_pool_minor: 0,
        min_players: config.minPlayers,
        max_players: config.maxPlayers,
        currency: input.currency,
        config,
        registration_opens_at: config.registrationOpensAt ?? null,
        registration_closes_at: config.registrationClosesAt ?? null,
        starts_at: config.startsAt ?? null,
      })
      .select("*")
      .single<TournamentRow>();

    if (inserted.error !== null || inserted.data === null) {
      throw new TournamentRepositoryError(
        `could not create the tournament: ${inserted.error?.message ?? "no row"}`,
      );
    }

    return toTournamentRecord(inserted.data);
  }

  async get(tournamentId: string): Promise<TournamentRecord | null> {
    const found = await this.#client
      .from("tournaments")
      .select("*")
      .eq("id", tournamentId)
      .maybeSingle<TournamentRow>();

    if (found.error !== null) {
      throw new TournamentRepositoryError(`could not read the tournament: ${found.error.message}`);
    }
    return found.data === null ? null : toTournamentRecord(found.data);
  }

  async list(filter?: {
    readonly status?: readonly TournamentStatus[];
    readonly game?: TournamentGame;
    readonly limit?: number;
  }): Promise<TournamentRecord[]> {
    let query = this.#client.from("tournaments").select("*");

    if (filter?.status !== undefined) {
      query = query.in("status", [...filter.status]);
    }
    if (filter?.game !== undefined) {
      query = query.eq("game", filter.game);
    }

    const found = await query
      .order("created_at", { ascending: true })
      .limit(filter?.limit ?? 100)
      .returns<TournamentRow[]>();

    if (found.error !== null) {
      throw new TournamentRepositoryError(`could not list tournaments: ${found.error.message}`);
    }
    return (found.data ?? []).map(toTournamentRecord);
  }

  async update(tournamentId: string, patch: TournamentPatch): Promise<TournamentRecord> {
    const row: Record<string, unknown> = {};
    if (patch.status !== undefined) {
      row["status"] = patch.status;
    }
    if (patch.prizePoolMinor !== undefined) {
      row["prize_pool_minor"] = patch.prizePoolMinor;
    }
    if (patch.championPlayerId !== undefined) {
      row["champion_player_id"] = patch.championPlayerId;
    }
    if (patch.payouts !== undefined) {
      row["payouts"] = patch.payouts;
    }
    if (patch.finishedAt !== undefined) {
      row["finished_at"] = patch.finishedAt;
    }
    if (patch.cancelledAt !== undefined) {
      row["cancelled_at"] = patch.cancelledAt;
    }

    const updated = await this.#client
      .from("tournaments")
      .update(row)
      .eq("id", tournamentId)
      .select("*")
      .single<TournamentRow>();

    if (updated.error !== null || updated.data === null) {
      throw new TournamentRepositoryError(
        `could not update the tournament: ${updated.error?.message ?? "no row"}`,
      );
    }
    return toTournamentRecord(updated.data);
  }

  async transition(
    tournamentId: string,
    from: TournamentStatus,
    to: TournamentStatus,
  ): Promise<TournamentRecord | null> {
    // `eq("status", from)` makes the check part of the write, so only one caller
    // can move a tournament out of a status.
    const updated = await this.#client
      .from("tournaments")
      .update({ status: to })
      .eq("id", tournamentId)
      .eq("status", from)
      .select("*")
      .maybeSingle<TournamentRow>();

    if (updated.error !== null) {
      throw new TournamentRepositoryError(`could not change the status: ${updated.error.message}`);
    }
    return updated.data === null ? null : toTournamentRecord(updated.data);
  }

  async listEntries(tournamentId: string): Promise<EntryRecord[]> {
    const found = await this.#client
      .from("tournament_entries")
      .select(
        "tournament_id, player_id, seed, status, entry_fee_minor, registered_at, withdrawn_at, eliminated_round, players (display_name, kind, skill)",
      )
      .eq("tournament_id", tournamentId)
      .returns<EntryRow[]>();

    if (found.error !== null) {
      throw new TournamentRepositoryError(`could not read the entries: ${found.error.message}`);
    }
    return (found.data ?? []).map(toEntryRecord);
  }

  async getEntry(tournamentId: string, playerId: string): Promise<EntryRecord | null> {
    const found = await this.#client
      .from("tournament_entries")
      .select(
        "tournament_id, player_id, seed, status, entry_fee_minor, registered_at, withdrawn_at, eliminated_round, players (display_name, kind, skill)",
      )
      .eq("tournament_id", tournamentId)
      .eq("player_id", playerId)
      .maybeSingle<EntryRow>();

    if (found.error !== null) {
      throw new TournamentRepositoryError(`could not read the entry: ${found.error.message}`);
    }
    return found.data === null ? null : toEntryRecord(found.data);
  }

  async addEntry(input: NewEntry): Promise<EntryRecord> {
    const inserted = await this.#client
      .from("tournament_entries")
      .insert({
        tournament_id: input.tournamentId,
        player_id: input.playerId,
        seed: input.seed ?? null,
        status: "registered",
        entry_fee_minor: input.entryFeeMinor,
        registered_at: new Date().toISOString(),
      })
      .select("tournament_id")
      .maybeSingle<{ tournament_id: string }>();

    if (inserted.error !== null) {
      throw new TournamentRepositoryError(`could not add the entry: ${inserted.error.message}`);
    }

    const entry = await this.getEntry(input.tournamentId, input.playerId);
    if (entry === null) {
      throw new TournamentRepositoryError("the entry vanished after it was created");
    }
    return entry;
  }

  async updateEntry(tournamentId: string, playerId: string, patch: EntryPatch): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.status !== undefined) {
      row["status"] = patch.status;
    }
    if (patch.seed !== undefined) {
      row["seed"] = patch.seed;
    }
    if (patch.withdrawnAt !== undefined) {
      row["withdrawn_at"] = patch.withdrawnAt;
    }
    if (patch.eliminatedRound !== undefined) {
      row["eliminated_round"] = patch.eliminatedRound;
    }

    const updated = await this.#client
      .from("tournament_entries")
      .update(row)
      .eq("tournament_id", tournamentId)
      .eq("player_id", playerId);

    if (updated.error !== null) {
      throw new TournamentRepositoryError(`could not update the entry: ${updated.error.message}`);
    }
  }

  async playerForProfile(profileId: string, displayName: string): Promise<PlayerRecord> {
    const found = await this.#client
      .from("players")
      .select("id, display_name, kind, bot_policy, profile_id, skill")
      .eq("profile_id", profileId)
      .maybeSingle<PlayerRow>();

    if (found.error !== null) {
      throw new TournamentRepositoryError(`could not read the player: ${found.error.message}`);
    }
    if (found.data !== null) {
      return toPlayerRecord(found.data);
    }

    const created = await this.#client
      .from("players")
      .insert({ kind: "human", profile_id: profileId, display_name: displayName })
      .select("id, display_name, kind, bot_policy, profile_id, skill")
      .single<PlayerRow>();

    if (created.error !== null || created.data === null) {
      throw new TournamentRepositoryError(
        `could not create the player: ${created.error?.message ?? "no row"}`,
      );
    }
    return toPlayerRecord(created.data);
  }

  async createBotPlayer(level: BotLevel, displayName?: string): Promise<PlayerRecord> {
    const profile = BOT_PROFILES[level];
    const created = await this.#client
      .from("players")
      .insert({
        kind: "bot",
        display_name: displayName ?? `${profile.displayName} (bot)`,
        bot_policy: profile.policy,
        skill: { rating: botRating(level) },
      })
      .select("id, display_name, kind, bot_policy, profile_id, skill")
      .single<PlayerRow>();

    if (created.error !== null || created.data === null) {
      throw new TournamentRepositoryError(
        `could not create the bot: ${created.error?.message ?? "no row"}`,
      );
    }
    return toPlayerRecord(created.data);
  }

  async getPlayer(playerId: string): Promise<PlayerRecord | null> {
    const found = await this.#client
      .from("players")
      .select("id, display_name, kind, bot_policy, profile_id, skill")
      .eq("id", playerId)
      .maybeSingle<PlayerRow>();

    if (found.error !== null) {
      throw new TournamentRepositoryError(`could not read the player: ${found.error.message}`);
    }
    return found.data === null ? null : toPlayerRecord(found.data);
  }

  async insertPositions(tournamentId: string, positions: readonly NewPosition[]): Promise<void> {
    if (positions.length === 0) {
      return;
    }

    const inserted = await this.#client.from("tournament_matches").insert(
      positions.map((position) => ({
        tournament_id: tournamentId,
        round: position.round,
        slot: position.slot,
        winner_to_slot: position.winnerToSlot,
        seat_1_player_id: position.seat1PlayerId,
        seat_2_player_id: position.seat2PlayerId,
        status: position.status,
        due_at: position.dueAt,
      })),
    );

    if (inserted.error !== null) {
      throw new TournamentRepositoryError(
        `could not insert the bracket: ${inserted.error.message}`,
      );
    }
  }

  async listPositions(tournamentId: string): Promise<BracketPositionRecord[]> {
    const found = await this.#client
      .from("tournament_matches")
      .select(
        "id, tournament_id, round, slot, winner_to_slot, seat_1_player_id, seat_2_player_id, status, due_at, launched_at, completed_at, winner_player_id, loser_player_id, match_id, is_walkover, points",
      )
      .eq("tournament_id", tournamentId)
      .order("round", { ascending: true })
      .order("slot", { ascending: true })
      .returns<PositionRow[]>();

    if (found.error !== null) {
      throw new TournamentRepositoryError(`could not read the bracket: ${found.error.message}`);
    }
    return (found.data ?? []).map(toPositionRecord);
  }

  async getPosition(positionId: string): Promise<BracketPositionRecord | null> {
    const found = await this.#client
      .from("tournament_matches")
      .select(
        "id, tournament_id, round, slot, winner_to_slot, seat_1_player_id, seat_2_player_id, status, due_at, launched_at, completed_at, winner_player_id, loser_player_id, match_id, is_walkover, points",
      )
      .eq("id", positionId)
      .maybeSingle<PositionRow>();

    if (found.error !== null) {
      throw new TournamentRepositoryError(`could not read the position: ${found.error.message}`);
    }
    return found.data === null ? null : toPositionRecord(found.data);
  }

  async updatePosition(positionId: string, patch: PositionPatch): Promise<BracketPositionRecord> {
    const row: Record<string, unknown> = {};
    if (patch.seat1PlayerId !== undefined) {
      row["seat_1_player_id"] = patch.seat1PlayerId;
    }
    if (patch.seat2PlayerId !== undefined) {
      row["seat_2_player_id"] = patch.seat2PlayerId;
    }
    if (patch.status !== undefined) {
      row["status"] = patch.status;
    }
    if (patch.dueAt !== undefined) {
      row["due_at"] = patch.dueAt;
    }
    if (patch.matchId !== undefined) {
      row["match_id"] = patch.matchId;
    }
    if (patch.points !== undefined) {
      row["points"] = patch.points;
    }
    if (patch.launchedAt !== undefined) {
      row["launched_at"] = patch.launchedAt;
    }

    const updated = await this.#client
      .from("tournament_matches")
      .update(row)
      .eq("id", positionId)
      .select(
        "id, tournament_id, round, slot, winner_to_slot, seat_1_player_id, seat_2_player_id, status, due_at, launched_at, completed_at, winner_player_id, loser_player_id, match_id, is_walkover, points",
      )
      .single<PositionRow>();

    if (updated.error !== null || updated.data === null) {
      throw new TournamentRepositoryError(
        `could not update the position: ${updated.error?.message ?? "no row"}`,
      );
    }
    return toPositionRecord(updated.data);
  }

  async claimPosition(positionId: string, at: string): Promise<BracketPositionRecord | null> {
    // The claim is the update itself: `is launched_at null` makes it a single
    // atomic step, so a second scheduler gets no row back and launches nothing.
    const claimed = await this.#client
      .from("tournament_matches")
      .update({ launched_at: at, status: "live" })
      .eq("id", positionId)
      .is("launched_at", null)
      .select(
        "id, tournament_id, round, slot, winner_to_slot, seat_1_player_id, seat_2_player_id, status, due_at, launched_at, completed_at, winner_player_id, loser_player_id, match_id, is_walkover, points",
      )
      .maybeSingle<PositionRow>();

    if (claimed.error !== null) {
      throw new TournamentRepositoryError(`could not claim the position: ${claimed.error.message}`);
    }
    return claimed.data === null ? null : toPositionRecord(claimed.data);
  }

  async completePosition(
    positionId: string,
    result: PositionResult,
    at: string,
  ): Promise<BracketPositionRecord | null> {
    const completed = await this.#client
      .from("tournament_matches")
      .update({
        status: result.isWalkover ? "walkover" : "finished",
        winner_player_id: result.winnerPlayerId,
        loser_player_id: result.loserPlayerId,
        completed_at: at,
        is_walkover: result.isWalkover,
        points: result.points ?? null,
      })
      .eq("id", positionId)
      .is("winner_player_id", null)
      .select(
        "id, tournament_id, round, slot, winner_to_slot, seat_1_player_id, seat_2_player_id, status, due_at, launched_at, completed_at, winner_player_id, loser_player_id, match_id, is_walkover, points",
      )
      .maybeSingle<PositionRow>();

    if (completed.error !== null) {
      throw new TournamentRepositoryError(
        `could not complete the position: ${completed.error.message}`,
      );
    }
    return completed.data === null ? null : toPositionRecord(completed.data);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: number | string | null): number {
  if (value === null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

function toTournamentRecord(row: TournamentRow): TournamentRecord {
  const config = tournamentConfigSchema.parse(row.config ?? {});

  return {
    id: row.id,
    game: row.game === "ludo" ? "ludo" : "carrom",
    name: row.name,
    format: config.format,
    status: toStatus(row.status),
    entryFeeMinor: toNumber(row.entry_fee_minor),
    prizePoolMinor: toNumber(row.prize_pool_minor),
    minPlayers: row.min_players ?? config.minPlayers,
    maxPlayers: row.max_players ?? config.maxPlayers,
    currency: row.currency ?? "NGN",
    config,
    registrationOpensAt: row.registration_opens_at,
    registrationClosesAt: row.registration_closes_at,
    startsAt: row.starts_at,
    championPlayerId: row.champion_player_id,
    payouts: toPayouts(row.payouts),
    finishedAt: row.finished_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

function toPayouts(value: unknown): readonly TournamentPayoutRecord[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const payouts: TournamentPayoutRecord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const playerId = entry["playerId"];
    const place = entry["place"];
    const amountMinor = entry["amountMinor"];
    if (
      typeof playerId === "string" &&
      typeof place === "number" &&
      typeof amountMinor === "number"
    ) {
      payouts.push({
        playerId,
        place,
        amountMinor,
        viaBotPlayerId:
          typeof entry["viaBotPlayerId"] === "string" ? entry["viaBotPlayerId"] : null,
      });
    }
  }
  return payouts;
}

function toStatus(value: string): TournamentStatus {
  switch (value) {
    case "registration":
    case "running":
    case "finished":
    case "cancelled":
      return value;
    default:
      return "draft";
  }
}

function toEntryStatus(value: string): EntryStatus {
  switch (value) {
    case "active":
    case "eliminated":
    case "winner":
    case "withdrawn":
      return value;
    default:
      return "registered";
  }
}

function toPositionStatus(value: string): PositionStatus {
  switch (value) {
    case "ready":
    case "live":
    case "finished":
    case "walkover":
    case "void":
      return value;
    default:
      return "pending";
  }
}

function toEntryRecord(row: EntryRow): EntryRecord {
  const skill = isRecord(row.players?.skill) ? row.players.skill : {};
  const rating = typeof skill["rating"] === "number" ? skill["rating"] : 1000;

  return {
    tournamentId: row.tournament_id,
    playerId: row.player_id,
    seed: row.seed,
    status: toEntryStatus(row.status),
    entryFeeMinor: toNumber(row.entry_fee_minor),
    registeredAt: row.registered_at,
    withdrawnAt: row.withdrawn_at,
    eliminatedRound: row.eliminated_round,
    isBot: row.players?.kind === "bot",
    displayName: row.players?.display_name ?? row.player_id,
    rating,
  };
}

function toPositionRecord(row: PositionRow): BracketPositionRecord {
  const points = isRecord(row.points)
    ? {
        seat1: typeof row.points["seat1"] === "number" ? row.points["seat1"] : 0,
        seat2: typeof row.points["seat2"] === "number" ? row.points["seat2"] : 0,
      }
    : null;

  return {
    id: row.id,
    tournamentId: row.tournament_id,
    round: row.round,
    slot: row.slot,
    winnerToSlot: row.winner_to_slot,
    seat1PlayerId: row.seat_1_player_id,
    seat2PlayerId: row.seat_2_player_id,
    status: toPositionStatus(row.status),
    dueAt: row.due_at,
    launchedAt: row.launched_at,
    completedAt: row.completed_at,
    winnerPlayerId: row.winner_player_id,
    loserPlayerId: row.loser_player_id,
    matchId: row.match_id,
    isWalkover: row.is_walkover,
    points,
  };
}

function toPlayerRecord(row: PlayerRow): PlayerRecord {
  const skill = isRecord(row.skill) ? row.skill : {};
  const rating = typeof skill["rating"] === "number" ? skill["rating"] : 1000;
  const isBot = row.kind === "bot";
  const level = row.bot_policy === null ? null : levelForPolicy(row.bot_policy);

  return {
    id: row.id,
    displayName: row.display_name,
    isBot,
    botLevel: isBot ? (level ?? "club") : null,
    botPolicy: row.bot_policy,
    profileId: row.profile_id,
    rating,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let override: TournamentRepository | null = null;
let supabaseStore: TournamentRepository | null = null;

/** The repository the service and the API use. */
export function tournamentRepository(): TournamentRepository {
  if (override !== null) {
    return override;
  }
  supabaseStore ??= new SupabaseTournamentRepository();
  return supabaseStore;
}

/** Replaces the store, for tests. Pass null to go back to Supabase. */
export function setTournamentRepository(repository: TournamentRepository | null): void {
  override = repository;
}
