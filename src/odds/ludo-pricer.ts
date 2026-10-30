/**
 * Pricing a Ludo match.
 *
 * A price is a frequency: play the match a million times, count how often each
 * selection wins, and hand back odds with the house margin applied and both ends
 * clamped. Nothing here guesses and nothing here is analytic, because Ludo has no
 * closed form once captures, stacking and the extra rolls are in it.
 *
 * Two rules make a million games fit in a minute:
 *
 * - the games are played on a worker pool, split by seed so the batch is
 *   reproducible however many threads played it;
 * - the batch size is chosen against a budget. A short calibration run measures
 *   this machine's rate, and if a million games would not finish inside the
 *   budget the price falls back to the 200,000 the brief allows, and says so in
 *   the log and in the report. A price that quietly took ninety seconds is worse
 *   than a price with a wider confidence interval.
 *
 * The margin, the clamp and the margin check are the Carrom engine's, imported
 * rather than re-derived, so the two games cannot drift apart on what a price is.
 */

import { logger } from "../lib/logger.js";
import { matchRepository } from "../lib/match-store.js";
import { marketsRepository, type MarketRow, type MarketsRepository } from "./markets-store.js";
import {
  MAX_ODDS,
  MAX_PROBABILITY,
  MAX_STAKE_BY_TIER,
  MIN_ODDS,
  MIN_PROBABILITY,
  houseMarginBps,
  oddsFor,
} from "./config.js";
import { ludoCatalog, type LudoCatalog } from "./catalog/ludo.js";
import { selectionId } from "./ludo-count.js";
import { runLudoBatch, type LudoBatchResult } from "./ludo-pool.js";
import { EVEN_POLICY_MIX, type LudoPolicyMix } from "./ludo-sim.js";
import { policyForSeat } from "./ludo-skill.js";
import type { CatalogMarket } from "./catalog/carrom.js";
import type { LudoBotId, LudoConfig, LudoState } from "../engines/ludo/index.js";
import type { MatchRecord, MatchRepository } from "../lib/match-repository.js";

/** What the brief asks for when there is time. */
export const LUDO_PRICE_SIMULATIONS = 1_000_000;
/** What it falls back to when there is not. */
export const LUDO_FALLBACK_SIMULATIONS = 200_000;
/** The time a pre-match price may take. */
export const LUDO_PRICE_BUDGET_MS = 60_000;
/** Games the calibration run plays to measure this machine. */
export const LUDO_CALIBRATION_GAMES = 20_000;

/** One priced selection. */
export interface LudoPricedSelection {
  readonly selectionKey: string;
  readonly name: string;
  readonly fairProbability: number;
  readonly oddsDecimal: number;
  readonly maxStakeMinor: number;
  /** True when no simulated game judged it: it would settle void. */
  readonly settledVoid: boolean;
}

/** One priced market. */
export interface LudoPricedMarket {
  readonly marketType: string;
  readonly subject: string;
  readonly line: number | null;
  readonly name: string;
  readonly isLive: boolean;
  readonly selections: readonly LudoPricedSelection[];
}

/** What a price run produced. */
export interface LudoPriceReport {
  readonly matchId: string;
  readonly simulations: number;
  readonly gamesPlayed: number;
  readonly abandonedGames: number;
  readonly threads: number;
  readonly elapsedMs: number;
  readonly fellBack: boolean;
  readonly markets: readonly LudoPricedMarket[];
  readonly warnings: readonly string[];
  /** Selection count, the number the brief calls "priced markets". */
  readonly selections: number;
}

export interface LudoPriceOptions {
  readonly repository?: MarketsRepository;
  readonly matches?: MatchRepository;
  readonly catalog?: LudoCatalog;
  readonly simulations?: number;
  readonly budgetMs?: number;
  /** Threads for the pool. Tests set one. */
  readonly threads?: number;
  /** A position to price from: a live match resumes where the board is. */
  readonly resume?: LudoState;
  /** Policies by seat, overriding what the match says. */
  readonly policies?: Readonly<Record<number, LudoBotId | LudoPolicyMix>>;
  readonly config?: Partial<LudoConfig>;
  readonly status?: "open" | "suspended";
  readonly write?: boolean;
  readonly seed?: string;
  /** A clock, so a test does not depend on real time passing. */
  readonly now?: () => number;
}

/** The policy each seat plays: a bot its own, a human the mix read from their games. */
export function policiesFromMatch(
  match: MatchRecord,
): Readonly<Record<number, LudoBotId | LudoPolicyMix>> {
  const policies: Record<number, LudoBotId | LudoPolicyMix> = {};
  match.seats.forEach((seat, index) => {
    // `match.seats` is in turn order; the catalogue keys on seat number, and a
    // two player game sits on seats 0 and 2.
    const seatNumber = match.seats.length === 2 ? index * 2 : index;
    policies[seatNumber] = policyForSeat({
      isBot: seat.isBot,
      // The published Ludo policy, not the Carrom skill tier: a Ludo bot table
      // carries one of cautious, aggressive or racer in `botPolicy`.
      botPolicy: seat.botPolicy,
    });
  });
  return policies;
}

/**
 * Whether a market's selections are mutually exclusive.
 *
 * A book whose selections sum to one plus the margin is one where exactly one
 * selection wins. The cumulative tiers (`1+ captures`, `2+`, `3+`) all win at
 * once on a good day, so their inverse sum is meant to be far above the margin
 * and checking it would only produce noise.
 */
function isExclusiveMarket(market: CatalogMarket): boolean {
  return !market.selections.every((selection) => selection.key.startsWith("at_least_"));
}

/** The probability a selection won, over the games that judged it. */
function probabilityOf(
  counts: ReadonlyMap<string, { readonly won: number; readonly decided: number }>,
  market: CatalogMarket,
  key: string,
): number | null {
  const tally = counts.get(
    selectionId({ key, marketType: market.marketType, subject: market.subject, line: market.line }),
  );
  if (tally === undefined || tally.decided === 0) {
    return null;
  }
  return tally.won / tally.decided;
}

/**
 * Decides how many games to play.
 *
 * The calibration batch is the honest way to keep the promise: this machine's
 * speed is measured rather than assumed, and the budget decides the size. A
 * machine that can do a million in time does; one that cannot does the fallback
 * rather than blow the deadline.
 */
export async function chooseBatchSize(options: {
  readonly budgetMs: number;
  readonly target: number;
  readonly fallback: number;
  readonly seed: string;
  readonly policies: Readonly<Record<number, LudoBotId | LudoPolicyMix>>;
  readonly config?: Partial<LudoConfig>;
  readonly threads?: number;
  readonly markets?: readonly CatalogMarket[];
  readonly resume?: LudoState;
  readonly now: () => number;
}): Promise<{ readonly games: number; readonly fellBack: boolean; readonly ratePerMs: number }> {
  // A live reprice plays a few thousand games: there is nothing to calibrate, and
  // a 20,000 game measurement would cost more than the price it is sizing.
  if (options.target <= LUDO_CALIBRATION_GAMES) {
    return { games: options.target, fellBack: false, ratePerMs: 0 };
  }

  const started = options.now();
  const calibration = await runLudoBatch({
    games: LUDO_CALIBRATION_GAMES,
    seed: `${options.seed}:calibration`,
    policies: options.policies,
    config: options.config,
    markets: options.markets,
    threads: options.threads,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  });
  const calibrationMs = Math.max(1, options.now() - started);
  const ratePerMs = calibration.games / calibrationMs;
  const projectedMs = options.target / ratePerMs;

  if (projectedMs <= options.budgetMs) {
    return { games: options.target, fellBack: false, ratePerMs };
  }

  const fallbackMs = options.fallback / ratePerMs;
  logger.warn(
    { ratePerMs, projectedMs, budgetMs: options.budgetMs, fallbackMs },
    "a million ludo games will not fit the budget: pricing on the fallback",
  );
  return { games: options.fallback, fellBack: true, ratePerMs };
}

/**
 * Prices every market of a Ludo match.
 *
 * The games are seeded from the match id, so pricing the same match twice with
 * the same policies produces the same prices while nothing has changed.
 */
export async function priceLudoMatch(
  matchId: string,
  options: LudoPriceOptions = {},
): Promise<LudoPriceReport> {
  const matches = options.matches ?? matchRepository();
  const repository = options.repository ?? marketsRepository();
  const catalog = options.catalog ?? ludoCatalog();
  const now = options.now ?? (() => Date.now());
  const seed = options.seed ?? matchId;
  const rowStatus = options.status ?? "open";
  const budgetMs = options.budgetMs ?? LUDO_PRICE_BUDGET_MS;
  const target = options.simulations ?? LUDO_PRICE_SIMULATIONS;

  const match = await matches.get(matchId);
  if (match === null) {
    throw new Error(`no match ${matchId}`);
  }

  const policies = options.policies ?? policiesFromMatch(match);
  if (Object.keys(policies).length === 0) {
    throw new Error(`match ${matchId} has no seats to price`);
  }

  const started = now();
  const choice = await chooseBatchSize({
    budgetMs,
    target,
    fallback: Math.min(LUDO_FALLBACK_SIMULATIONS, target),
    seed,
    policies,
    config: options.config,
    threads: options.threads,
    markets: catalog.markets,
    resume: options.resume,
    now,
  });

  const batch = await runLudoBatch({
    games: choice.games,
    seed,
    policies,
    config: options.config,
    markets: catalog.markets,
    threads: options.threads,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  });

  const report = buildPrice({
    matchId,
    catalog,
    batch,
    threads: batch.threads,
    elapsedMs: now() - started,
    fellBack: choice.fellBack,
    status: rowStatus,
  });

  if (options.write !== false) {
    await repository.upsert(report.rows);
  }

  return report.report;
}

/** The priced markets, the rows and the warnings, from a batch's tallies. */
function buildPrice(input: {
  readonly matchId: string;
  readonly catalog: LudoCatalog;
  readonly batch: LudoBatchResult;
  readonly threads: number;
  readonly elapsedMs: number;
  readonly fellBack: boolean;
  readonly status: "open" | "suspended";
}): { readonly report: LudoPriceReport; readonly rows: readonly MarketRow[] } {
  const marginBps = houseMarginBps();
  const expected = 1 + marginBps / 10_000;
  const warnings: string[] = [];
  const markets: LudoPricedMarket[] = [];
  const rows: MarketRow[] = [];
  let selections = 0;

  for (const market of input.catalog.markets) {
    const priced: LudoPricedSelection[] = [];
    let inverseSum = 0;
    let decided = 0;
    let clamped = false;

    for (const selection of market.selections) {
      const measured = probabilityOf(input.batch.counts, market, selection.key);
      if (measured !== null && (measured < MIN_PROBABILITY || measured > MAX_PROBABILITY)) {
        clamped = true;
      }
      const fair =
        measured === null
          ? MIN_PROBABILITY
          : Math.min(MAX_PROBABILITY, Math.max(MIN_PROBABILITY, measured));
      const odds = oddsFor(fair, marginBps);
      if (odds <= MIN_ODDS || odds >= MAX_ODDS) {
        // The allowed odds band cut this price: a selection priced at 1.01 cannot
        // carry its share of the margin, so the market's inverse sum falls short
        // by construction. That is a liability cap, not a pricing error.
        clamped = true;
      }
      if (measured !== null) {
        decided += 1;
        inverseSum += 1 / odds;
      }

      priced.push({
        selectionKey: selection.key,
        name: selection.name,
        fairProbability: fair,
        oddsDecimal: odds,
        maxStakeMinor: MAX_STAKE_BY_TIER[market.stakeTier],
        settledVoid: measured === null,
      });

      rows.push({
        matchId: input.matchId,
        marketType: market.marketType,
        subject: market.subject,
        line: market.line,
        selectionKey: selection.key,
        status: input.status,
        fairProbability: fair,
        oddsDecimal: odds,
        maxStakeMinor: MAX_STAKE_BY_TIER[market.stakeTier],
        isLive: market.live,
      });
      selections += 1;
    }

    // The same check the Carrom book makes: a market whose priced selections
    // sum to something other than one plus the margin is a numbers bug.
    if (decided > 0 && !clamped && isExclusiveMarket(market)) {
      const error = Math.abs(inverseSum - expected) / expected;
      if (error > 0.01) {
        warnings.push(
          `${market.marketType}${market.subject === "" ? "" : ` ${market.subject}`}${
            market.line === null ? "" : ` @ ${String(market.line)}`
          }: 1/odds sums to ${inverseSum.toFixed(4)}, expected ${expected.toFixed(4)}`,
        );
      }
    }

    markets.push({
      marketType: market.marketType,
      subject: market.subject,
      line: market.line,
      name: market.name,
      isLive: market.live,
      selections: priced,
    });
  }

  if (warnings.length > 0) {
    logger.warn(
      { matchId: input.matchId, warnings: warnings.slice(0, 5) },
      "ludo market margin outside one percent",
    );
  }

  const report: LudoPriceReport = {
    matchId: input.matchId,
    simulations: input.batch.games,
    gamesPlayed: input.batch.games,
    abandonedGames: input.batch.abandoned,
    threads: input.threads,
    elapsedMs: Math.round(input.elapsedMs),
    fellBack: input.fellBack,
    markets,
    warnings,
    selections,
  };

  return { report, rows };
}

/** The even mix, exported so a caller pricing an unknown human has a named default. */
export const LUDO_DEFAULT_MIX = EVEN_POLICY_MIX;
