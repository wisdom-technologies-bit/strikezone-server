import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.js";
import type { PlacementConfig } from "./place.js";
import { isRejectionCode, BetRejected } from "./errors.js";
import type {
  BetResult,
  BetRow,
  BetStatus,
  BetWithMarket,
  PlaceBetRequest,
  PlacedBet,
} from "./types.js";

/**
 * Everything the money layer reads and writes about bets.
 *
 * Placing is one call: the Supabase implementation sends it to `place_bet`, so
 * the locks, the limits and the exposure checks happen in one database
 * transaction. Settlement works on rows, and every write is idempotent by bet
 * id, so re-running a settlement cannot pay twice.
 */

/** A change settlement makes to one bet. */
export interface SettleBetPatch {
  readonly status: BetStatus;
  readonly result: BetResult;
  readonly payoutMinor: number;
  readonly settledAt: string;
  readonly reviewReason?: string | null;
}

export interface BetsRepository {
  /** Places a bet through the atomic path, or throws {@link BetRejected}. */
  place(request: PlaceBetRequest, config: PlacementConfig): Promise<PlacedBet>;
  get(betId: string): Promise<BetRow | null>;
  byIdempotencyKey(key: string): Promise<BetRow | null>;
  /** Every bet on a match that is still open or waiting for review. */
  listForMatch(matchId: string): Promise<BetWithMarket[]>;
  listPendingReview(): Promise<BetWithMarket[]>;
  /** A player's own bets, newest first. */
  listForPlayer(userId: string): Promise<BetRow[]>;
  settle(betId: string, patch: SettleBetPatch): Promise<void>;
  /** Records a review decision without touching the money. */
  review(
    betId: string,
    patch: { readonly status: BetStatus; readonly reviewedAt: string; readonly reviewedBy: string },
  ): Promise<void>;
  /** Marks the match as untrustworthy. Settlement refuses a flagged match. */
  flagMatch(matchId: string, reason: string, at: string): Promise<void>;
}

export class BetsRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BetsRepositoryError";
  }
}

interface BetRowShape {
  id: string;
  user_id: string;
  market_id: string;
  stake_minor: number | string;
  odds_locked: number | string;
  potential_payout_minor: number | string;
  status: string;
  result: string | null;
  payout_minor: number | string | null;
  idempotency_key: string;
  placed_at: string;
  settled_at: string | null;
  review_reason: string | null;
}

const BET_COLUMNS =
  "id, user_id, market_id, stake_minor, odds_locked, potential_payout_minor, status, result, payout_minor, idempotency_key, placed_at, settled_at, review_reason";

function toBet(row: BetRowShape): BetRow {
  return {
    id: row.id,
    userId: row.user_id,
    marketId: row.market_id,
    stakeMinor: Number(row.stake_minor),
    oddsLocked: Number(row.odds_locked),
    potentialPayoutMinor: Number(row.potential_payout_minor),
    status: row.status as BetStatus,
    result: (row.result ?? null) as BetResult | null,
    payoutMinor: row.payout_minor === null ? null : Number(row.payout_minor),
    idempotencyKey: row.idempotency_key,
    placedAt: row.placed_at,
    settledAt: row.settled_at,
    reviewReason: row.review_reason,
  };
}

/** The reply `place_bet` builds. Anything else is a refusal. */
interface PlaceBetReply {
  ok?: boolean;
  replayed?: boolean;
  code?: string;
  bet?: BetRowShape;
  balanceMinor?: number;
  [key: string]: unknown;
}

export class SupabaseBetsRepository implements BetsRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async place(request: PlaceBetRequest, config: PlacementConfig): Promise<PlacedBet> {
    const result = await this.#client.rpc("place_bet", {
      p_user_id: request.userId,
      p_market_id: request.marketId,
      p_stake_minor: request.stakeMinor,
      p_expected_odds: request.expectedOdds,
      p_idempotency_key: request.idempotencyKey,
      p_min_stake_minor: config.minStakeMinor,
      p_match_exposure_pct: config.matchExposurePct,
      p_require_kyc: config.requireKyc,
    });

    if (result.error !== null) {
      throw new BetsRepositoryError(`place_bet failed: ${result.error.message}`);
    }

    const reply = result.data as PlaceBetReply | null;
    if (reply === null) {
      throw new BetsRepositoryError("place_bet returned nothing");
    }

    if (reply.ok !== true) {
      const code = typeof reply.code === "string" ? reply.code : "invalid_request";
      const details: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(reply)) {
        if (key === "ok" || key === "code" || key === "bet") {
          continue;
        }
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null
        ) {
          details[key] = value;
        }
      }
      throw new BetRejected(isRejectionCode(code) ? code : "invalid_request", details);
    }

    if (reply.bet === undefined) {
      throw new BetsRepositoryError("place_bet accepted a bet but returned no row");
    }

    const balance = typeof reply.balanceMinor === "number" ? reply.balanceMinor : 0;

    return {
      bet: toBet(reply.bet),
      replayed: reply.replayed === true,
      balanceMinor: balance,
    };
  }

  async get(betId: string): Promise<BetRow | null> {
    const result = await this.#client
      .from("bets")
      .select(BET_COLUMNS)
      .eq("id", betId)
      .maybeSingle<BetRowShape>();

    if (result.error !== null) {
      throw new BetsRepositoryError(`could not read the bet: ${result.error.message}`);
    }
    return result.data === null ? null : toBet(result.data);
  }

  async byIdempotencyKey(key: string): Promise<BetRow | null> {
    const result = await this.#client
      .from("bets")
      .select(BET_COLUMNS)
      .eq("idempotency_key", key)
      .maybeSingle<BetRowShape>();

    if (result.error !== null) {
      throw new BetsRepositoryError(`could not read the bet: ${result.error.message}`);
    }
    return result.data === null ? null : toBet(result.data);
  }

  async listForMatch(matchId: string): Promise<BetWithMarket[]> {
    const result = await this.#client
      .from("bets")
      .select(
        `${BET_COLUMNS}, markets!inner (id, match_id, market_type, subject, line, selection_key)`,
      )
      .eq("markets.match_id", matchId)
      .in("status", ["open", "pending_review"])
      .returns<(BetRowShape & { markets: MarketShape })[]>();

    if (result.error !== null) {
      throw new BetsRepositoryError(`could not read the bets: ${result.error.message}`);
    }

    return (result.data ?? []).map((row) => ({
      ...toBet(row),
      ...toMarket(row.markets),
    }));
  }

  async listPendingReview(): Promise<BetWithMarket[]> {
    const result = await this.#client
      .from("bets")
      .select(
        `${BET_COLUMNS}, markets!inner (id, match_id, market_type, subject, line, selection_key)`,
      )
      .eq("status", "pending_review")
      .order("settled_at", { ascending: true })
      .returns<(BetRowShape & { markets: MarketShape })[]>();

    if (result.error !== null) {
      throw new BetsRepositoryError(`could not read held payouts: ${result.error.message}`);
    }

    return (result.data ?? []).map((row) => ({
      ...toBet(row),
      ...toMarket(row.markets),
    }));
  }

  async listForPlayer(userId: string): Promise<BetRow[]> {
    const result = await this.#client
      .from("bets")
      .select(BET_COLUMNS)
      .eq("user_id", userId)
      .order("placed_at", { ascending: false })
      .returns<BetRowShape[]>();

    if (result.error !== null) {
      throw new BetsRepositoryError(`could not read the bets: ${result.error.message}`);
    }
    return (result.data ?? []).map(toBet);
  }

  async settle(betId: string, patch: SettleBetPatch): Promise<void> {
    const result = await this.#client
      .from("bets")
      .update({
        status: patch.status,
        result: patch.result,
        payout_minor: patch.payoutMinor,
        settled_at: patch.settledAt,
        review_reason: patch.reviewReason ?? null,
      })
      .eq("id", betId)
      .in("status", ["open", "pending_review"]);

    if (result.error !== null) {
      throw new BetsRepositoryError(`could not settle the bet: ${result.error.message}`);
    }
  }

  async review(
    betId: string,
    patch: { readonly status: BetStatus; readonly reviewedAt: string; readonly reviewedBy: string },
  ): Promise<void> {
    const result = await this.#client
      .from("bets")
      .update({
        status: patch.status,
        reviewed_at: patch.reviewedAt,
        reviewed_by: patch.reviewedBy,
      })
      .eq("id", betId)
      .eq("status", "pending_review");

    if (result.error !== null) {
      throw new BetsRepositoryError(`could not record the review: ${result.error.message}`);
    }
  }

  async flagMatch(matchId: string, reason: string, at: string): Promise<void> {
    const result = await this.#client
      .from("matches")
      .update({ flagged_at: at, flagged_reason: reason })
      .eq("id", matchId);

    if (result.error !== null) {
      throw new BetsRepositoryError(`could not flag the match: ${result.error.message}`);
    }
  }
}

interface MarketShape {
  id: string;
  match_id: string;
  market_type: string;
  subject: string;
  line: number | string | null;
  selection_key: string;
}

function toMarket(row: MarketShape): {
  marketRowId: string;
  matchId: string;
  marketType: string;
  subject: string;
  line: number | null;
  selectionKey: string;
} {
  return {
    marketRowId: row.id,
    matchId: row.match_id,
    marketType: row.market_type,
    subject: row.subject,
    line: row.line === null ? null : Number(row.line),
    selectionKey: row.selection_key,
  };
}

// ---------------------------------------------------------------------------
// In memory: settlement and API tests run here
// ---------------------------------------------------------------------------

/** A betting book in memory, for the settlement rules and the route tests. */
export class InMemoryBetsRepository implements BetsRepository {
  readonly #bets = new Map<string, MutableBet>();
  readonly #byKey = new Map<string, string>();
  readonly #markets = new Map<string, MarketShape>();
  readonly #placeHandler: ((request: PlaceBetRequest) => PlacedBet) | null;

  constructor(options: { readonly place?: (request: PlaceBetRequest) => PlacedBet } = {}) {
    this.#placeHandler = options.place ?? null;
  }

  /** Seeds a market so bets can point at it. */
  addMarket(market: MarketShape): void {
    this.#markets.set(market.id, market);
  }

  /** Seeds a bet directly, bypassing placement: used to build a book to settle. */
  addBet(bet: BetRow, marketId?: string): void {
    const market = this.#markets.get(marketId ?? bet.marketId);
    if (market === undefined) {
      throw new BetsRepositoryError(`no market ${marketId ?? bet.marketId} in the in-memory book`);
    }
    this.#bets.set(bet.id, { ...bet, market } as MutableBet);
    this.#byKey.set(bet.idempotencyKey, bet.id);
  }

  place(request: PlaceBetRequest): Promise<PlacedBet> {
    if (this.#placeHandler !== null) {
      return Promise.resolve(this.#placeHandler(request));
    }
    throw new BetsRepositoryError("this in-memory book has no place handler");
  }

  get(betId: string): Promise<BetRow | null> {
    const found = this.#bets.get(betId);
    return Promise.resolve(found === undefined ? null : strip(found));
  }

  byIdempotencyKey(key: string): Promise<BetRow | null> {
    const id = this.#byKey.get(key);
    return Promise.resolve(id === undefined ? null : strip(this.#bets.get(id)!));
  }

  listForMatch(matchId: string): Promise<BetWithMarket[]> {
    const found: BetWithMarket[] = [];
    for (const bet of this.#bets.values()) {
      if (bet.market.match_id !== matchId) {
        continue;
      }
      if (bet.status !== "open" && bet.status !== "pending_review") {
        continue;
      }
      found.push(withMarket(bet));
    }
    return Promise.resolve(found);
  }

  listPendingReview(): Promise<BetWithMarket[]> {
    const found: BetWithMarket[] = [];
    for (const bet of this.#bets.values()) {
      if (bet.status === "pending_review") {
        found.push(withMarket(bet));
      }
    }
    return Promise.resolve(found);
  }

  listForPlayer(userId: string): Promise<BetRow[]> {
    return Promise.resolve(
      [...this.#bets.values()]
        .filter((bet) => bet.userId === userId)
        .map((bet) => strip(bet))
        .reverse(),
    );
  }

  settle(betId: string, patch: SettleBetPatch): Promise<void> {
    const bet = this.#require(betId);
    bet.status = patch.status;
    bet.result = patch.result;
    bet.payoutMinor = patch.payoutMinor;
    bet.settledAt = patch.settledAt;
    bet.reviewReason = patch.reviewReason ?? null;
    this.#bets.set(betId, bet);
    return Promise.resolve();
  }

  review(
    betId: string,
    patch: { readonly status: BetStatus; readonly reviewedAt: string; readonly reviewedBy: string },
  ): Promise<void> {
    const bet = this.#require(betId);
    if (bet.status !== "pending_review") {
      throw new BetsRepositoryError(`bet ${betId} is ${bet.status}, not pending review`);
    }
    bet.status = patch.status;
    this.#bets.set(betId, bet);
    return Promise.resolve();
  }

  flagMatch(matchId: string, reason: string): Promise<void> {
    this.#flagged.set(matchId, reason);
    return Promise.resolve();
  }

  readonly #flagged = new Map<string, string>();

  /** The reason a match was flagged, or null. */
  flaggedReason(matchId: string): string | null {
    return this.#flagged.get(matchId) ?? null;
  }

  /** Every bet, for assertions about statuses and payouts. */
  all(): BetRow[] {
    return [...this.#bets.values()].map(strip);
  }

  #require(betId: string): MutableBet {
    const bet = this.#bets.get(betId);
    if (bet === undefined) {
      throw new BetsRepositoryError(`no bet ${betId}`);
    }
    return bet;
  }
}

/** A bet as the in-memory book keeps it: writable, with its market attached. */
type MutableBet = {
  -readonly [K in keyof BetRow]: BetRow[K];
} & { market: MarketShape };

function strip(bet: MutableBet): BetRow {
  const { market: _market, ...rest } = bet;
  return rest;
}

function withMarket(bet: MutableBet): BetWithMarket {
  return {
    ...strip(bet),
    marketRowId: bet.market.id,
    matchId: bet.market.match_id,
    marketType: bet.market.market_type,
    subject: bet.market.subject,
    line: bet.market.line === null ? null : Number(bet.market.line),
    selectionKey: bet.market.selection_key,
  };
}

/** A place handler that mints a bet, for tests that need a book to settle. */
export function mintBetFactory(): (request: PlaceBetRequest) => PlacedBet {
  let next = 1;
  return (request: PlaceBetRequest): PlacedBet => {
    const id = `bet_${next}`;
    next += 1;
    return {
      bet: {
        id,
        userId: request.userId,
        marketId: request.marketId,
        stakeMinor: request.stakeMinor,
        oddsLocked: request.expectedOdds,
        potentialPayoutMinor: Math.floor(request.stakeMinor * request.expectedOdds),
        status: "open",
        result: null,
        payoutMinor: null,
        idempotencyKey: request.idempotencyKey,
        placedAt: new Date().toISOString(),
        settledAt: null,
        reviewReason: null,
      },
      replayed: false,
      balanceMinor: 0,
    };
  };
}
