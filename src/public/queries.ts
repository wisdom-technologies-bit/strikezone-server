import type {
  LeaderboardEntry,
  LeaderboardQuery,
  MatchDetail,
  MatchSummary,
  MatchesQuery,
  TournamentResponse,
  TournamentSummary,
  Transaction,
  PlayerProfile,
  WalletResponse,
} from "../api/contract.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";

/**
 * The reads the public API serves.
 *
 * Everything here is read-only and player-facing, so it lives behind one
 * interface: the routes validate, cache and rate-limit, and this module talks to
 * Supabase. Tests substitute the interface, which is why the routes have no
 * database in them.
 *
 * Two rules shape the queries:
 * - a bot is labelled, never hidden: `is_bot` comes from the players table, and a
 *   leaderboard can include or exclude bots but never invents a rating;
 * - the seed is public only once the match is over. `seed_reveal` is returned for
 *   a finished match and nulled for a live one, in one place, here.
 */

export interface MatchesPage {
  readonly matches: readonly MatchSummary[];
  readonly nextCursor: string | null;
}

export interface TransactionsPage {
  readonly transactions: readonly Transaction[];
  readonly nextCursor: string | null;
}

export interface PublicConfig {
  readonly currency: string;
  readonly moneyMode: "virtual" | "real";
  readonly minStakeMinor: number;
  readonly maxStakeMinor: number;
  readonly houseMarginBps: number;
  readonly limits: {
    readonly minStakeMinor: number;
    readonly maxStakeMinor: number;
    readonly matchExposurePct: number;
    readonly largePayoutMinor: number;
    readonly betRateLimitPerMinute: number;
    readonly minAccountAgeHours: number;
  };
  readonly depositsEnabled: boolean;
}

export interface PublicQueries {
  config(): PublicConfig;
  matches(kind: "live" | "upcoming" | "recent", query: MatchesQuery): Promise<MatchesPage>;
  match(id: string): Promise<MatchDetail | null>;
  player(playerId: string): Promise<PlayerProfile | null>;
  leaderboard(query: LeaderboardQuery): Promise<readonly LeaderboardEntry[]>;
  tournaments(): Promise<readonly TournamentSummary[]>;
  tournament(id: string): Promise<TournamentResponse | null>;
  wallet(userId: string): Promise<Omit<WalletResponse, "ok">>;
  transactions(
    userId: string,
    query: { readonly limit: number; readonly cursor?: string | undefined },
  ): Promise<Omit<TransactionsPage, never> & { readonly currency: string }>;
}

/** One row of `matches`, as the queries read it. */
interface MatchRow {
  readonly id: string;
  readonly game: "carrom" | "ludo";
  readonly tournament_id: string | null;
  readonly status: "scheduled" | "live" | "finished" | "void";
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly scheduled_at: string | null;
  readonly seed_commit: string | null;
  readonly seed_reveal: string | null;
  readonly result_signature: string | null;
  readonly log_head_hash: string | null;
  readonly result: Record<string, unknown> | null;
}

interface SeatRow {
  readonly match_id: string;
  readonly seat: number;
  readonly player_id: string;
  readonly players:
    | { readonly display_name: string; readonly kind: "human" | "bot"; readonly bot_policy: string | null }
    | null;
}

const MATCH_COLUMNS =
  "id, game, tournament_id, status, started_at, ended_at, scheduled_at, seed_commit, seed_reveal, result_signature, log_head_hash, result";

function scoresOf(result: Record<string, unknown> | null): { white: number; black: number } | null {
  if (result === null) {
    return null;
  }
  const scores = result["scores"];
  if (typeof scores !== "object" || scores === null) {
    return null;
  }
  const white = (scores as Record<string, unknown>)["white"];
  const black = (scores as Record<string, unknown>)["black"];
  if (typeof white !== "number" || typeof black !== "number") {
    return null;
  }
  return { white, black };
}

function botLevelOf(kind: "human" | "bot", policy: string | null): "rookie" | "club" | "master" | null {
  if (kind !== "bot") {
    return null;
  }
  return policy === "rookie" || policy === "club" || policy === "master" ? policy : null;
}

function seatsOf(rows: readonly SeatRow[], matchId: string): MatchSummary["players"] {
  return rows
    .filter((row) => row.match_id === matchId && (row.seat === 1 || row.seat === 2))
    .sort((left, right) => left.seat - right.seat)
    .map((row) => ({
      seat: row.seat === 2 ? (2 as const) : (1 as const),
      playerId: row.player_id,
      displayName: row.players?.display_name ?? "Unknown",
      isBot: row.players?.kind === "bot",
      botLevel: botLevelOf(row.players?.kind ?? "human", row.players?.bot_policy ?? null),
      score: null,
    }));
}

function summaryOf(row: MatchRow, seats: readonly SeatRow[]): MatchSummary {
  const scores = scoresOf(row.result);

  return {
    id: row.id,
    game: row.game,
    status: row.status,
    tournamentId: row.tournament_id,
    isTournament: row.tournament_id !== null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    players: seatsOf(seats, row.id).map((player) => ({
      ...player,
      score: scores === null ? null : player.seat === 1 ? scores.white : scores.black,
    })),
    scores,
    // The room id is the match id: one room per match, created by the server.
    roomId: row.status === "live" ? row.id : null,
  };
}

/** Reads matches, their seats and the players in those seats. */
class SupabasePublicQueries implements PublicQueries {
  config(): PublicConfig {
    return {
      currency: env.CURRENCY,
      moneyMode: env.MONEY_MODE,
      minStakeMinor: env.MIN_STAKE_MINOR,
      maxStakeMinor: env.MAX_STAKE_MINOR,
      houseMarginBps: env.HOUSE_MARGIN_BPS,
      limits: {
        minStakeMinor: env.MIN_STAKE_MINOR,
        maxStakeMinor: env.MAX_STAKE_MINOR,
        matchExposurePct: env.MATCH_EXPOSURE_PCT,
        largePayoutMinor: env.LARGE_PAYOUT_MINOR,
        betRateLimitPerMinute: env.BET_RATE_LIMIT_PER_MINUTE,
        minAccountAgeHours: env.MIN_ACCOUNT_AGE_HOURS,
      },
      depositsEnabled: true,
    };
  }

  async matches(kind: "live" | "upcoming" | "recent", query: MatchesQuery): Promise<MatchesPage> {
    let builder = supabase.from("matches").select(MATCH_COLUMNS);

    if (query.game !== undefined) {
      builder = builder.eq("game", query.game);
    }
    if (query.tournamentId !== undefined) {
      builder = builder.eq("tournament_id", query.tournamentId);
    }

    if (kind === "live") {
      builder = builder.eq("status", "live").order("started_at", { ascending: true });
    } else if (kind === "upcoming") {
      builder = builder.eq("status", "scheduled").order("scheduled_at", { ascending: true });
    } else {
      builder = builder.in("status", ["finished", "void"]).order("ended_at", { ascending: false });
    }

    if (query.cursor !== undefined) {
      const cursorAt = query.cursor;
      builder =
        kind === "recent"
          ? builder.lt("ended_at", cursorAt)
          : kind === "upcoming"
            ? builder.gt("scheduled_at", cursorAt)
            : builder.gt("started_at", cursorAt);
    }

    const { data, error } = await builder.limit(query.limit + 1);
    if (error !== null) {
      throw new Error(`could not read matches: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as readonly MatchRow[];
    const page = rows.slice(0, query.limit);
    const seats = await this.#seatsFor(page.map((row) => row.id));
    const last = page.at(-1);

    return {
      matches: page.map((row) => summaryOf(row, seats)),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? (kind === "recent" ? last.ended_at : kind === "upcoming" ? last.scheduled_at : last.started_at)
          : null,
    };
  }

  async match(id: string): Promise<MatchDetail | null> {
    const { data, error } = await supabase.from("matches").select(MATCH_COLUMNS).eq("id", id).maybeSingle();
    if (error !== null) {
      throw new Error(`could not read the match: ${error.message}`);
    }
    if (data === null) {
      return null;
    }

    const row = data as unknown as MatchRow;
    const seats = await this.#seatsFor([row.id]);
    const summary = summaryOf(row, seats);
    const finished = row.status === "finished" || row.status === "void";
    const winner = row.result?.["winnerColour"];

    return {
      ...summary,
      players: summary.players,
      seedCommit: row.seed_commit,
      // The commitment is public from the start; the seed only after the end.
      seedReveal: finished ? row.seed_reveal : null,
      resultSignature: row.result_signature,
      logHeadHash: row.log_head_hash,
      result:
        winner === "white" || winner === "black" || winner === "tie"
          ? { winner: winner === "tie" ? "draw" : winner }
          : null,
    };
  }

  async player(playerId: string): Promise<PlayerProfile | null> {
    const { data, error } = await supabase
      .from("players")
      .select("id, kind, display_name, bot_policy, rating, created_at")
      .eq("id", playerId)
      .maybeSingle();

    if (error !== null) {
      throw new Error(`could not read the player: ${error.message}`);
    }
    if (data === null) {
      return null;
    }

    const row = data as unknown as {
      id: string;
      kind: "human" | "bot";
      display_name: string;
      bot_policy: string | null;
      rating: number | null;
      created_at: string;
    };

    const recent = await this.#recentResults(row.id);
    const won = recent.filter((entry) => entry.result === "won").length;
    const lost = recent.filter((entry) => entry.result === "lost").length;

    return {
      id: row.id,
      displayName: row.display_name,
      isBot: row.kind === "bot",
      botLevel: botLevelOf(row.kind, row.bot_policy),
      rating: row.rating === null ? null : Math.round(row.rating),
      played: recent.length,
      won,
      lost,
      recentResults: recent,
    };
  }

  async leaderboard(query: LeaderboardQuery): Promise<readonly LeaderboardEntry[]> {
    let builder = supabase
      .from("players")
      .select("id, kind, display_name, rating")
      .order("rating", { ascending: false, nullsFirst: false });

    if (query.bots === "exclude") {
      builder = builder.eq("kind", "human");
    } else if (query.bots === "only") {
      builder = builder.eq("kind", "bot");
    }

    const { data, error } = await builder.limit(query.limit);
    if (error !== null) {
      throw new Error(`could not read the leaderboard: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as readonly {
      id: string;
      kind: "human" | "bot";
      display_name: string;
      rating: number | null;
    }[];

    return rows.map((row, index) => ({
      rank: index + 1,
      playerId: row.id,
      displayName: row.display_name,
      isBot: row.kind === "bot",
      rating: row.rating === null ? null : Math.round(row.rating),
      played: 0,
      won: 0,
    }));
  }

  async tournaments(): Promise<readonly TournamentSummary[]> {
    const { data, error } = await supabase
      .from("tournaments")
      .select("id, name, game, format, status, entry_fee_minor, prize_pool_minor, max_players, starts_at, created_at")
      .order("starts_at", { ascending: false, nullsFirst: false })
      .limit(50);

    if (error !== null) {
      throw new Error(`could not read tournaments: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as readonly {
      id: string;
      name: string;
      format: string;
      status: string;
      entry_fee_minor: number;
      prize_pool_minor: number;
      max_players: number | null;
      starts_at: string | null;
      created_at: string;
    }[];

    const counts = await this.#entryCounts(rows.map((row) => row.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status:
        row.status === "registration"
          ? ("open" as const)
          : row.status === "draft" || row.status === "running" || row.status === "finished" || row.status === "cancelled"
            ? (row.status as "draft" | "running" | "finished" | "cancelled")
            : ("draft" as const),
      format: row.format === "round_robin" ? ("round_robin" as const) : ("single_elimination" as const),
      maxPlayers: row.max_players ?? 16,
      entries: counts.get(row.id) ?? 0,
      entryFeeMinor: row.entry_fee_minor,
      prizePoolMinor: row.prize_pool_minor,
      startsAt: row.starts_at,
      createdAt: row.created_at,
    }));
  }

  async tournament(id: string): Promise<TournamentResponse | null> {
    const all = await this.tournaments();
    const summary = all.find((entry) => entry.id === id);
    if (summary === undefined) {
      return null;
    }

    const { data, error } = await supabase
      .from("tournament_entries")
      .select("player_id, seed, status, players(display_name, kind)")
      .eq("tournament_id", id);

    if (error !== null) {
      throw new Error(`could not read entrants: ${error.message}`);
    }

    const entrants = ((data ?? []) as unknown as readonly {
      player_id: string;
      seed: number | null;
      status: string;
      players: { display_name: string; kind: "human" | "bot" } | null;
    }[]).map((row) => ({
      playerId: row.player_id,
      displayName: row.players?.display_name ?? "Unknown",
      isBot: row.players?.kind === "bot",
      seed: row.seed,
      eliminatedAt: null,
    }));

    return {
      ok: true,
      tournament: summary,
      entrants,
      matches: [],
      champion: null,
    };
  }

  async wallet(userId: string): Promise<Omit<WalletResponse, "ok">> {
    const accountId = await this.#userAccount(userId);

    const { data, error } = await supabase
      .from("account_balances")
      .select("balance_minor")
      .eq("account_id", accountId)
      .maybeSingle();

    if (error !== null) {
      throw new Error(`could not read the balance: ${error.message}`);
    }

    const available = Number((data as { balance_minor: number } | null)?.balance_minor ?? 0);

    const { data: openBets } = await supabase
      .from("bets")
      .select("stake_minor")
      .eq("user_id", userId)
      .in("status", ["open", "pending_review"]);

    const atRisk = ((openBets ?? []) as readonly { stake_minor: number }[]).reduce(
      (sum, row) => sum + Number(row.stake_minor),
      0,
    );

    const { data: withdrawals } = await supabase
      .from("withdrawals")
      .select("amount_minor")
      .eq("user_id", userId)
      .in("status", ["requested", "approved"]);

    const pending = ((withdrawals ?? []) as readonly { amount_minor: number }[]).reduce(
      (sum, row) => sum + Number(row.amount_minor),
      0,
    );

    return {
      currency: env.CURRENCY,
      availableMinor: available,
      atRiskMinor: atRisk,
      pendingWithdrawalMinor: pending,
      totalBalanceMinor: available + atRisk + pending,
    };
  }

  async transactions(
    userId: string,
    query: { readonly limit: number; readonly cursor?: string | undefined },
  ): Promise<Omit<TransactionsPage, never> & { readonly currency: string }> {
    const accountId = await this.#userAccount(userId);

    let builder = supabase
      .from("ledger_entries")
      .select("id, amount_minor, created_at, transaction_id, ledger_transactions(kind, ref_type, ref_id)")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(query.limit + 1);

    if (query.cursor !== undefined) {
      builder = builder.lt("created_at", query.cursor);
    }

    const { data, error } = await builder;
    if (error !== null) {
      throw new Error(`could not read transactions: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as readonly {
      id: string;
      amount_minor: number;
      created_at: string;
      transaction_id: string;
      ledger_transactions: { kind: string; ref_type: string | null; ref_id: string | null } | null;
    }[];

    const page = rows.slice(0, query.limit);
    const balanceNow = await this.#balance(accountId);

    // Running balance, newest first: the newest entry ends at today's balance, so
    // each older one subtracts the amount that came after it.
    let running = balanceNow;
    const transactions = page.map((row) => {
      const amount = Number(row.amount_minor);
      const entry = {
        id: row.transaction_id,
        kind: row.ledger_transactions?.kind ?? "unknown",
        refType: row.ledger_transactions?.ref_type ?? null,
        refId: row.ledger_transactions?.ref_id ?? null,
        amountMinor: amount,
        balanceAfterMinor: running,
        createdAt: row.created_at,
      };
      running -= amount;
      return entry;
    });

    return {
      currency: env.CURRENCY,
      transactions,
      nextCursor: rows.length > query.limit ? (page.at(-1)?.created_at ?? null) : null,
    };
  }

  async #seatsFor(matchIds: readonly string[]): Promise<readonly SeatRow[]> {
    if (matchIds.length === 0) {
      return [];
    }

    const { data, error } = await supabase
      .from("match_players")
      .select("match_id, seat, player_id, players(display_name, kind, bot_policy)")
      .in("match_id", [...matchIds]);

    if (error !== null) {
      throw new Error(`could not read the seats: ${error.message}`);
    }

    return (data ?? []) as unknown as readonly SeatRow[];
  }

  async #entryCounts(tournamentIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (tournamentIds.length === 0) {
      return counts;
    }

    const { data } = await supabase
      .from("tournament_entries")
      .select("tournament_id")
      .in("tournament_id", [...tournamentIds]);

    for (const row of (data ?? []) as readonly { tournament_id: string }[]) {
      counts.set(row.tournament_id, (counts.get(row.tournament_id) ?? 0) + 1);
    }

    return counts;
  }

  async #recentResults(playerId: string): Promise<PlayerProfile["recentResults"]> {
    const { data, error } = await supabase
      .from("match_players")
      .select("match_id, seat, matches(id, status, ended_at, result, match_players(seat, players(display_name)))")
      .eq("player_id", playerId)
      .limit(10);

    if (error !== null) {
      logger.warn({ err: error }, "could not read recent results");
      return [];
    }

    type Joined = {
      match_id: string;
      seat: number;
      matches: {
        id: string;
        status: string;
        ended_at: string | null;
        result: Record<string, unknown> | null;
        match_players: readonly { seat: number; players: { display_name: string } | null }[];
      } | null;
    };

    return ((data ?? []) as unknown as readonly Joined[])
      .filter((row) => row.matches !== null && row.matches.status === "finished" && row.matches.ended_at !== null)
      .map((row) => {
        const match = row.matches;
        const winnerSeat = match?.result?.["winnerSeat"];
        const opponent = match?.match_players.find((seat) => seat.seat !== row.seat);
        const scores = scoresOf(match?.result ?? null);

        return {
          matchId: row.match_id,
          opponent: opponent?.players?.display_name ?? "Unknown",
          result:
            typeof winnerSeat === "number"
              ? winnerSeat === row.seat
                ? ("won" as const)
                : ("lost" as const)
              : ("draw" as const),
          score: scores === null ? "" : `${String(scores.white)}-${String(scores.black)}`,
          endedAt: match?.ended_at ?? new Date(0).toISOString(),
        };
      });
  }

  async #userAccount(userId: string): Promise<string> {
    const { data, error } = await supabase
      .from("wallet_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("owner_type", "user")
      .eq("currency", env.CURRENCY)
      .maybeSingle();

    if (error !== null) {
      throw new Error(`could not find the wallet: ${error.message}`);
    }
    if (data === null) {
      throw new Error("this player has no wallet in this currency");
    }

    return (data as { id: string }).id;
  }

  async #balance(accountId: string): Promise<number> {
    const { data } = await supabase
      .from("account_balances")
      .select("balance_minor")
      .eq("account_id", accountId)
      .maybeSingle();

    return Number((data as { balance_minor: number } | null)?.balance_minor ?? 0);
  }
}

let override: PublicQueries | null = null;
let instance: PublicQueries | null = null;

/** Swaps the queries, for tests. */
export function setPublicQueries(replacement: PublicQueries | null): void {
  override = replacement;
}

/** The queries in use. */
export function publicQueries(): PublicQueries {
  if (override !== null) {
    return override;
  }
  instance ??= new SupabasePublicQueries();
  return instance;
}
