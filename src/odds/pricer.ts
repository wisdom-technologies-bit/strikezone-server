import { logger } from "../lib/logger.js";
import { matchRepository } from "../lib/match-store.js";
import type { MatchRecord, MatchRepository, MatchSeat } from "../lib/match-repository.js";
import { simulateFastMatch, type FastSkill } from "./carrom-fast-model.js";
import {
  carromCatalog,
  type CarromCatalog,
  type CatalogMarket,
  type Settlement,
} from "./catalog/carrom.js";
import {
  MAX_STAKE_BY_TIER,
  MAX_PROBABILITY,
  MIN_PROBABILITY,
  PRICE_SIMULATIONS,
  houseMarginBps,
  oddsFor,
} from "./config.js";
import { marketsRepository, type MarketRow, type MarketsRepository } from "./markets-store.js";
import { botSkill, CLUB_SKILL } from "./skill.js";

/**
 * Pricing: play the match many times in the fast model, count how often each
 * selection wins, and turn those counts into odds.
 *
 * Nothing here guesses. A price is a frequency, measured over simulations, with
 * the house margin applied and both ends clamped so a model error cannot publish
 * a 1.00 or a 5000.00.
 */

export interface PricedSelection {
  readonly selectionKey: string;
  readonly name: string;
  readonly fairProbability: number;
  readonly oddsDecimal: number;
  readonly maxStakeMinor: number;
  readonly settledVoid: boolean;
}

export interface PricedMarket {
  readonly marketType: string;
  readonly subject: string;
  readonly line: number | null;
  readonly name: string;
  readonly isLive: boolean;
  readonly status: MarketStatusLike;
  readonly selections: readonly PricedSelection[];
}

type MarketStatusLike = "open" | "suspended" | "closed";

export interface PriceOptions {
  /** How many matches to simulate. Default 100,000. */
  readonly simulations?: number;
  readonly catalog?: CarromCatalog;
  readonly repository?: MarketsRepository;
  /** Where to read the match from. Defaults to the shared store. */
  readonly matches?: MatchRepository;
  /**
   * The status the written rows carry. A live reprice writes them suspended, so
   * a bettor cannot take a price that is half-recomputed.
   */
  readonly status?: "open" | "suspended";
  /** Write the prices to the markets table. Default true. */
  readonly write?: boolean;
  readonly seedPrefix?: string;
  /** Overrides the skill of each seat, for a live reprice or a test. */
  readonly skills?: (match: MatchRecord) => {
    readonly white: FastSkill;
    readonly black: FastSkill;
  };
}

export interface PriceResult {
  readonly matchId: string;
  readonly simulations: number;
  readonly markets: readonly PricedMarket[];
  readonly warnings: readonly string[];
}

/** A bot's published numbers, or Club's for a human with no history yet. */
export function skillForSeat(seat: MatchSeat): FastSkill {
  if (seat.isBot && seat.botLevel !== null) {
    const skill = botSkill(seat.botLevel);
    return {
      aimErrorDegrees: skill.aimErrorDegrees,
      selectionQuality: skill.selectionQuality,
      foulRate: skill.foulRate,
    };
  }

  // Humans keep a default until their own history is loaded (see skill.ts):
  // pricing a stranger as a Club player is the least wrong assumption we have.
  return {
    aimErrorDegrees: CLUB_SKILL.aimErrorDegrees,
    selectionQuality: CLUB_SKILL.selectionQuality,
    foulRate: CLUB_SKILL.foulRate,
  };
}

function skillsFromMatch(match: MatchRecord): { white: FastSkill; black: FastSkill } {
  const white = match.seats.find((seat) => seat.seat === 1);
  const black = match.seats.find((seat) => seat.seat === 2);

  if (white === undefined || black === undefined) {
    throw new Error(`match ${match.id} does not have two seats`);
  }

  return { white: skillForSeat(white), black: skillForSeat(black) };
}

/** Counts how often each selection of each market wins across simulations. */
class Tally {
  readonly #won = new Map<string, number>();
  readonly #decided = new Map<string, number>();

  count(market: CatalogMarket, key: string, settlement: Settlement): void {
    if (settlement === "void") {
      return;
    }
    const id = `${market.marketType}|${market.subject}|${String(market.line ?? "")}|${key}`;
    this.#decided.set(id, (this.#decided.get(id) ?? 0) + 1);
    if (settlement === "won") {
      this.#won.set(id, (this.#won.get(id) ?? 0) + 1);
    }
  }

  probability(market: CatalogMarket, key: string): number | null {
    const id = `${market.marketType}|${market.subject}|${String(market.line ?? "")}|${key}`;
    const decided = this.#decided.get(id) ?? 0;
    if (decided === 0) {
      return null;
    }
    return (this.#won.get(id) ?? 0) / decided;
  }
}

/**
 * Prices every market of a match.
 *
 * The simulations are seeded from the match id, so pricing the same match twice
 * gives the same prices while nothing has changed.
 */
export async function priceMatch(
  matchId: string,
  options: PriceOptions = {},
): Promise<PriceResult> {
  const matches = options.matches ?? matchRepository();
  const match = await matches.get(matchId);
  if (match === null) {
    throw new Error(`no match ${matchId}`);
  }

  const simulations = options.simulations ?? PRICE_SIMULATIONS;
  const catalog = options.catalog ?? carromCatalog();
  const repository = options.repository ?? marketsRepository();
  const seedPrefix = options.seedPrefix ?? matchId;
  const skills = (options.skills ?? skillsFromMatch)(match);
  const rowStatus = options.status ?? "open";

  const tally = new Tally();

  for (let index = 0; index < simulations; index += 1) {
    const stats = simulateFastMatch({
      matchId,
      seed: `${seedPrefix}:${String(index)}`,
      white: {
        playerId: match.seats[0]?.playerId ?? "white",
        displayName: match.seats[0]?.displayName ?? "White",
        isBot: match.seats[0]?.isBot ?? false,
        skill: skills.white,
      },
      black: {
        playerId: match.seats[1]?.playerId ?? "black",
        displayName: match.seats[1]?.displayName ?? "Black",
        isBot: match.seats[1]?.isBot ?? false,
        skill: skills.black,
      },
    });

    for (const market of catalog.markets) {
      for (const selection of market.selections) {
        tally.count(market, selection.key, catalog.settle(market, selection.key, stats));
      }
    }
  }

  const marginBps = houseMarginBps();
  const warnings: string[] = [];
  const priced: PricedMarket[] = [];
  const rows: MarketRow[] = [];

  for (const market of catalog.markets) {
    const selections: PricedSelection[] = [];
    let inverseSum = 0;
    let anyDecided = false;

    for (const selection of market.selections) {
      const measured = tally.probability(market, selection.key);
      // Clamped at both ends: below by the config floor, above because a
      // selection that won every simulation is still not a certainty, and the
      // markets table refuses a probability of exactly one.
      const fair =
        measured === null
          ? MIN_PROBABILITY
          : Math.min(MAX_PROBABILITY, Math.max(MIN_PROBABILITY, measured));
      const odds = oddsFor(fair, marginBps);
      if (measured !== null) {
        anyDecided = true;
        inverseSum += 1 / odds;
      }

      selections.push({
        selectionKey: selection.key,
        name: selection.name,
        fairProbability: fair,
        oddsDecimal: odds,
        maxStakeMinor: MAX_STAKE_BY_TIER[market.stakeTier],
        settledVoid: measured === null,
      });

      rows.push({
        matchId,
        marketType: market.marketType,
        subject: market.subject,
        line: market.line,
        selectionKey: selection.key,
        status: rowStatus,
        fairProbability: fair,
        oddsDecimal: odds,
        maxStakeMinor: MAX_STAKE_BY_TIER[market.stakeTier],
        isLive: market.live,
      });
    }

    // A book priced off real frequencies should have 1/odds summing to
    // 1 + margin. A market outside that by more than a percent is a numbers
    // bug, not a trader's decision, so it is logged loudly.
    if (anyDecided) {
      const expected = 1 + marginBps / 10_000;
      const error = Math.abs(inverseSum - expected) / expected;
      if (error > 0.01) {
        warnings.push(
          `${market.marketType}${market.subject === "" ? "" : ` ${market.subject}`}${
            market.line === null ? "" : ` @ ${String(market.line)}`
          }: 1/odds sums to ${inverseSum.toFixed(4)}, expected ${expected.toFixed(4)}`,
        );
      }
    }

    priced.push({
      marketType: market.marketType,
      subject: market.subject,
      line: market.line,
      name: market.name,
      isLive: market.live,
      status: rowStatus,
      selections,
    });
  }

  if (warnings.length > 0) {
    logger.warn({ matchId, warnings: warnings.slice(0, 5) }, "market margin outside one percent");
  }

  if (options.write !== false) {
    await repository.upsert(rows);
  }

  return { matchId, simulations, markets: priced, warnings };
}

/** Reads the markets of a match, grouped by market type, as the API returns them. */
export async function marketsForMatch(
  matchId: string,
  repository: MarketsRepository = marketsRepository(),
): Promise<Map<string, MarketRow[]>> {
  const rows = await repository.listForMatch(matchId);
  const grouped = new Map<string, MarketRow[]>();

  for (const row of rows) {
    const list = grouped.get(row.marketType) ?? [];
    list.push(row);
    grouped.set(row.marketType, list);
  }

  return grouped;
}
