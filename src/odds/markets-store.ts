import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.js";

/**
 * The markets table, as the odds engine sees it.
 *
 * The engine may write only here (AI_RULES.md hard rule 4). One row is one
 * selection: a market is every row sharing match, type, subject and line.
 */

export type MarketStatus = "open" | "suspended" | "closed" | "settled" | "void";

export interface MarketRow {
  readonly matchId: string;
  readonly marketType: string;
  readonly subject: string;
  readonly line: number | null;
  readonly selectionKey: string;
  readonly status: MarketStatus;
  readonly fairProbability: number;
  readonly oddsDecimal: number;
  readonly maxStakeMinor: number;
  readonly isLive: boolean;
}

export interface MarketsRepository {
  /** Writes the given rows, replacing any row for the same selection. */
  upsert(rows: readonly MarketRow[]): Promise<void>;
  listForMatch(matchId: string): Promise<MarketRow[]>;
  /** Moves every open market of a match to a new status. */
  setStatus(matchId: string, status: MarketStatus, options?: { live?: boolean }): Promise<void>;
  /** Moves the named markets of a match to a new status. */
  setStatusForTypes(
    matchId: string,
    marketTypes: readonly string[],
    status: MarketStatus,
  ): Promise<void>;
  /** Suspends or reopens one row, for the admin market switch. */
  setSelectionStatus(marketId: string, status: MarketStatus): Promise<boolean>;
}

export class MarketsRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketsRepositoryError";
  }
}

/** Rows in memory, keyed by selection identity, for tests and simulations. */
export class InMemoryMarketsRepository implements MarketsRepository {
  #rows = new Map<string, MarketRow>();

  #key(
    row: Pick<MarketRow, "matchId" | "marketType" | "subject" | "line" | "selectionKey">,
  ): string {
    return [
      row.matchId,
      row.marketType,
      row.subject,
      String(row.line ?? ""),
      row.selectionKey,
    ].join("|");
  }

  async upsert(rows: readonly MarketRow[]): Promise<void> {
    for (const row of rows) {
      this.#rows.set(this.#key(row), row);
    }
  }

  async listForMatch(matchId: string): Promise<MarketRow[]> {
    return [...this.#rows.values()].filter((row) => row.matchId === matchId);
  }

  async setStatus(
    matchId: string,
    status: MarketStatus,
    options: { live?: boolean } = {},
  ): Promise<void> {
    for (const [key, row] of this.#rows) {
      if (row.matchId !== matchId) {
        continue;
      }
      if (options.live !== undefined && row.isLive !== options.live) {
        continue;
      }
      this.#rows.set(key, { ...row, status });
    }
  }

  async setStatusForTypes(
    matchId: string,
    marketTypes: readonly string[],
    status: MarketStatus,
  ): Promise<void> {
    const wanted = new Set(marketTypes);
    for (const [key, row] of this.#rows) {
      if (row.matchId === matchId && wanted.has(row.marketType)) {
        this.#rows.set(key, { ...row, status });
      }
    }
  }

  setSelectionStatus(marketId: string, status: MarketStatus): Promise<boolean> {
    for (const [key, row] of [...this.#rows.entries()]) {
      const id = marketIdFor(row);
      if (id === marketId) {
        this.#rows.set(key, { ...row, status });
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }
}

/** The id a row would have in the database: its five identity fields. */
export function marketIdFor(
  row: Pick<MarketRow, "matchId" | "marketType" | "subject" | "line" | "selectionKey">,
): string {
  return [row.matchId, row.marketType, row.subject, String(row.line ?? ""), row.selectionKey].join(
    "|",
  );
}

interface MarketDbRow {
  match_id: string;
  market_type: string;
  subject: string;
  line: number | string | null;
  selection_key: string;
  status: string;
  fair_probability: number | string;
  odds_decimal: number | string;
  max_stake_minor: number | string | null;
  is_live: boolean;
}

function toNumber(value: number | string | null): number {
  return value === null ? 0 : Number(value);
}

export class SupabaseMarketsRepository implements MarketsRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient = supabase) {
    this.#client = client;
  }

  async upsert(rows: readonly MarketRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const payload = rows.map((row) => ({
      match_id: row.matchId,
      market_type: row.marketType,
      subject: row.subject,
      line: row.line,
      selection_key: row.selectionKey,
      status: row.status,
      fair_probability: row.fairProbability,
      odds_decimal: row.oddsDecimal,
      max_stake_minor: row.maxStakeMinor,
      is_live: row.isLive,
      updated_at: new Date().toISOString(),
    }));

    // The table has a unique key over (match_id, market_type, subject, line,
    // selection_key), so a reprice replaces the row instead of duplicating it.
    const result = await this.#client
      .from("markets")
      .upsert(payload, { onConflict: "match_id,market_type,subject,line,selection_key" });

    if (result.error !== null) {
      throw new MarketsRepositoryError(`could not write the markets: ${result.error.message}`);
    }
  }

  async listForMatch(matchId: string): Promise<MarketRow[]> {
    const result = await this.#client
      .from("markets")
      .select(
        "match_id, market_type, subject, line, selection_key, status, fair_probability, odds_decimal, max_stake_minor, is_live",
      )
      .eq("match_id", matchId)
      .returns<MarketDbRow[]>();

    if (result.error !== null) {
      throw new MarketsRepositoryError(`could not read the markets: ${result.error.message}`);
    }

    return (result.data ?? []).map((row) => ({
      matchId: row.match_id,
      marketType: row.market_type,
      subject: row.subject,
      line: row.line === null ? null : toNumber(row.line),
      selectionKey: row.selection_key,
      status: row.status as MarketStatus,
      fairProbability: toNumber(row.fair_probability),
      oddsDecimal: toNumber(row.odds_decimal),
      maxStakeMinor: toNumber(row.max_stake_minor),
      isLive: row.is_live,
    }));
  }

  async setStatus(
    matchId: string,
    status: MarketStatus,
    options: { live?: boolean } = {},
  ): Promise<void> {
    let query = this.#client.from("markets").update({ status }).eq("match_id", matchId);
    if (options.live !== undefined) {
      query = query.eq("is_live", options.live);
    }

    const result = await query;
    if (result.error !== null) {
      throw new MarketsRepositoryError(`could not update the markets: ${result.error.message}`);
    }
  }

  async setStatusForTypes(
    matchId: string,
    marketTypes: readonly string[],
    status: MarketStatus,
  ): Promise<void> {
    if (marketTypes.length === 0) {
      return;
    }

    const result = await this.#client
      .from("markets")
      .update({ status })
      .eq("match_id", matchId)
      .in("market_type", [...marketTypes]);

    if (result.error !== null) {
      throw new MarketsRepositoryError(`could not update the markets: ${result.error.message}`);
    }
  }

  async setSelectionStatus(marketId: string, status: MarketStatus): Promise<boolean> {
    const result = await this.#client
      .from("markets")
      .update({ status })
      .eq("id", marketId)
      .select("id");

    if (result.error !== null) {
      throw new MarketsRepositoryError(`could not update the market: ${result.error.message}`);
    }
    return (result.data ?? []).length > 0;
  }
}

let override: MarketsRepository | null = null;

/** Swaps the store, for tests. */
export function setMarketsRepository(repository: MarketsRepository | null): void {
  override = repository;
}

/** The store in use. */
export function marketsRepository(): MarketsRepository {
  override ??= new SupabaseMarketsRepository();
  return override;
}
