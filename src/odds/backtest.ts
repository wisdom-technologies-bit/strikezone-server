import { carromCatalog, type CarromCatalog } from "./catalog/carrom.js";
import { simulateFastMatch, type FastSkill } from "./carrom-fast-model.js";
import { botSkill, CLUB_SKILL } from "./skill.js";
import { computeMatchStats, type MatchStats } from "./stats.js";
import type { MatchLogEntry } from "../lib/match-log.js";
import type { MatchRecord } from "../lib/match-repository.js";

/**
 * Is the model's probability honest?
 *
 * Every priced selection is a claim: "this happens this often". The backtest
 * tests the claim against matches that actually finished. Each real match is
 * re-simulated with the model to get a predicted probability for the same
 * pairing, the real match says whether the selection won, and the pairs are
 * bucketed in tens of percent.
 *
 * A calibrated model has an observed rate inside each bucket equal to the
 * bucket's predicted rate. Ten point buckets are coarse enough that a few
 * hundred matches say something, and fine enough that a systematic bias cannot
 * hide in an average.
 */

/** One priced claim and what happened. */
/** A bucket needs this many claims before its error is worth reading. */
export const MINIMUM_PER_BUCKET = 20;

export interface BacktestSample {
  readonly marketType: string;
  readonly predicted: number;
  readonly actual: boolean;
}

export interface CalibrationRow {
  /** 0 for 0-10%, 9 for 90-100%. */
  readonly bucket: number;
  readonly label: string;
  readonly count: number;
  readonly predicted: number;
  /** Share of the samples in this bucket that happened. */
  readonly observed: number;
  readonly error: number;
}

export interface BacktestReport {
  readonly matches: number;
  readonly samples: number;
  readonly rows: readonly CalibrationRow[];
  /** Mean squared error of the prediction, lower is better. */
  readonly brier: number;
  /** Largest |observed - predicted| over buckets with enough samples. */
  readonly worstError: number;
}

/** Buckets predictions in tens of percent and reports what actually happened. */
export function bucketCalibration(
  samples: readonly BacktestSample[],
  options: { readonly minimumPerBucket?: number } = {},
): BacktestReport {
  const minimum = options.minimumPerBucket ?? MINIMUM_PER_BUCKET;
  const buckets = new Map<number, { predicted: number; hits: number; count: number }>();

  let squaredError = 0;

  for (const sample of samples) {
    const index = Math.min(9, Math.max(0, Math.floor(sample.predicted * 10)));
    const bucket = buckets.get(index) ?? { predicted: 0, hits: 0, count: 0 };
    bucket.predicted += sample.predicted;
    bucket.count += 1;
    if (sample.actual) {
      bucket.hits += 1;
    }
    buckets.set(index, bucket);

    const outcome = sample.actual ? 1 : 0;
    squaredError += (sample.predicted - outcome) ** 2;
  }

  const rows: CalibrationRow[] = [];
  let worstError = 0;

  for (let index = 0; index < 10; index += 1) {
    const bucket = buckets.get(index);
    if (bucket === undefined || bucket.count === 0) {
      continue;
    }
    const predicted = bucket.predicted / bucket.count;
    const observed = bucket.hits / bucket.count;
    const error = Math.abs(observed - predicted);
    if (bucket.count >= minimum) {
      worstError = Math.max(worstError, error);
    }
    rows.push({
      bucket: index,
      label: `${String(index * 10)}-${String(index * 10 + 10)}%`,
      count: bucket.count,
      predicted,
      observed,
      error,
    });
  }

  return {
    matches: 0,
    samples: samples.length,
    rows,
    brier: samples.length === 0 ? 0 : squaredError / samples.length,
    worstError,
  };
}

/** The markets a backtest scores: decided by the match, not by a single board. */
const BACKTEST_MARKETS = [
  "match_winner",
  "total_boards_ou",
  "total_points",
  "total_fouls",
  "player_points",
] as const;

function skillForSeat(seat: MatchRecord["seats"][number]): FastSkill {
  if (seat.isBot && seat.botLevel !== null) {
    return botSkill(seat.botLevel);
  }
  return CLUB_SKILL;
}

export interface BacktestOptions {
  /** How many finished matches to read. Default 200. */
  readonly matches?: number;
  /** Model simulations per real match. Default 2000. */
  readonly simulations?: number;
  readonly catalog?: CarromCatalog;
  readonly loadMatches: () => Promise<
    readonly { readonly match: MatchRecord; readonly events: readonly MatchLogEntry[] }[]
  >;
}

/**
 * Compares the model with finished matches.
 *
 * The model is re-run with the same skills the two seats had, so the predicted
 * probabilities describe the pairing that actually played, not an average one.
 */
export async function runBacktest(options: BacktestOptions): Promise<BacktestReport> {
  const catalog = options.catalog ?? carromCatalog();
  const simulations = options.simulations ?? 2000;
  const loaded = await options.loadMatches();
  const samples: BacktestSample[] = [];

  for (const { match, events } of loaded) {
    const actual: MatchStats = computeMatchStats(match.id, events);
    if (!actual.finished) {
      continue;
    }

    const [whiteSeat, blackSeat] = match.seats;
    if (whiteSeat === undefined || blackSeat === undefined) {
      continue;
    }
    const white = skillForSeat(whiteSeat);
    const black = skillForSeat(blackSeat);
    const markets = catalog.markets.filter((market) =>
      (BACKTEST_MARKETS as readonly string[]).includes(market.marketType),
    );

    const tally = new Map<string, { won: number; decided: number }>();

    for (let index = 0; index < simulations; index += 1) {
      const simulated = simulateFastMatch({
        matchId: match.id,
        seed: `${match.id}:backtest:${String(index)}`,
        white: {
          playerId: whiteSeat.playerId ?? "white",
          displayName: "White",
          isBot: whiteSeat.isBot,
          skill: white,
        },
        black: {
          playerId: blackSeat.playerId ?? "black",
          displayName: "Black",
          isBot: blackSeat.isBot,
          skill: black,
        },
      });

      for (const market of markets) {
        for (const selection of market.selections) {
          const id = `${market.marketType}|${market.subject}|${String(market.line ?? "")}|${selection.key}`;
          const settlement = catalog.settle(market, selection.key, simulated);
          if (settlement === "void") {
            continue;
          }
          const entry = tally.get(id) ?? { won: 0, decided: 0 };
          entry.decided += 1;
          if (settlement === "won") {
            entry.won += 1;
          }
          tally.set(id, entry);
        }
      }
    }

    for (const market of markets) {
      for (const selection of market.selections) {
        const id = `${market.marketType}|${market.subject}|${String(market.line ?? "")}|${selection.key}`;
        const entry = tally.get(id);
        if (entry === undefined || entry.decided === 0) {
          continue;
        }
        const settlement = catalog.settle(market, selection.key, actual);
        if (settlement === "void" || settlement === "push") {
          continue;
        }
        samples.push({
          marketType: market.marketType,
          predicted: entry.won / entry.decided,
          actual: settlement === "won",
        });
      }
    }
  }

  const report = bucketCalibration(samples);
  return { ...report, matches: loaded.length };
}
