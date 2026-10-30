import { Router } from "express";
import { z } from "zod";
import { carromCatalog } from "../odds/catalog/carrom.js";
import {
  marketsRepository,
  type MarketRow,
  type MarketsRepository,
} from "../odds/markets-store.js";

/**
 * GET /api/matches/:id/markets
 *
 * Every price on a match, grouped by market type and in catalogue order.
 * Public: a price nobody can see is a price nobody can take.
 */
const paramsSchema = z.object({ id: z.string().min(1).max(64) });

export interface GroupedSelection {
  readonly selectionKey: string;
  readonly name: string;
  readonly oddsDecimal: number;
  readonly fairProbability: number;
  readonly maxStakeMinor: number;
  readonly status: MarketRow["status"];
}

export interface GroupedMarket {
  readonly marketType: string;
  readonly name: string;
  readonly subject: string;
  readonly line: number | null;
  readonly isLive: boolean;
  readonly status: MarketRow["status"];
  readonly selections: GroupedSelection[];
}

/** Identity of one market: rows sharing these four fields are its selections. */
export function marketIdentity(row: Pick<MarketRow, "marketType" | "subject" | "line">): string {
  return `${row.marketType}|${row.subject}|${String(row.line ?? "")}`;
}

/** Groups rows into markets, keeping catalogue order and catalogue names. */
export function groupMarkets(rows: readonly MarketRow[]): GroupedMarket[] {
  const catalog = carromCatalog();
  const names = new Map<string, string>();
  const namesBySelection = new Map<string, string>();
  const order = new Map<string, number>();

  for (const [index, market] of catalog.markets.entries()) {
    const identity = marketIdentity(market);
    names.set(identity, market.name);
    order.set(identity, index);
    for (const selection of market.selections) {
      namesBySelection.set(`${identity}|${selection.key}`, selection.name);
    }
  }

  const grouped = new Map<string, GroupedMarket>();

  for (const row of rows) {
    const identity = marketIdentity(row);
    const selection: GroupedSelection = {
      selectionKey: row.selectionKey,
      name: namesBySelection.get(`${identity}|${row.selectionKey}`) ?? row.selectionKey,
      oddsDecimal: row.oddsDecimal,
      fairProbability: row.fairProbability,
      maxStakeMinor: row.maxStakeMinor,
      status: row.status,
    };

    const existing = grouped.get(identity);
    if (existing === undefined) {
      grouped.set(identity, {
        marketType: row.marketType,
        name: names.get(identity) ?? row.marketType,
        subject: row.subject,
        line: row.line,
        isLive: row.isLive,
        status: row.status,
        selections: [selection],
      });
      continue;
    }

    existing.selections.push(selection);
  }

  return [...grouped.entries()]
    .sort(
      ([left], [right]) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(([, market]) => market);
}

export interface MarketsRouterDeps {
  readonly repository?: MarketsRepository;
}

export function createMarketsRouter(deps: MarketsRouterDeps = {}): Router {
  const router = Router();

  router.get("/api/matches/:id/markets", (request, response, next) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid match id" });
      return;
    }

    void (async () => {
      try {
        const repository = deps.repository ?? marketsRepository();
        const rows = await repository.listForMatch(parsed.data.id);
        response.json({
          ok: true,
          matchId: parsed.data.id,
          markets: groupMarkets(rows),
        });
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
