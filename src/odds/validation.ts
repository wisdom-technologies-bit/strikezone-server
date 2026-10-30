import type { BotLevel } from "../engines/carrom/bot-config.js";
import { resolveConfig } from "../engines/carrom/config.js";
import { commitOf } from "../lib/fair-rng.js";
import { InMemoryMatchRepository } from "../lib/match-repository.js";
import { CarromMatchRunner, runnerSeatsFromMatch } from "../rooms/carrom-match-runner.js";
import { simulateFastMatch, type FastSkill } from "./carrom-fast-model.js";
import { botSkill } from "./skill.js";
import { computeMatchStats, type MatchStats } from "./stats.js";

/**
 * The fast model, checked against the real thing.
 *
 * The fast model exists to answer "how likely is this?" in milliseconds. This
 * harness plays the same pairings through the real engine, one physics match at
 * a time, and compares what each says about who wins, how many points and boards
 * a match takes, and how often a player fouls.
 *
 * It is the only honest way to know whether a price is worth anything: without
 * it the fast model is a plausible-looking story.
 */

export interface Pairing {
  readonly label: string;
  readonly white: BotLevel;
  readonly black: BotLevel;
}

export const DEFAULT_PAIRINGS: readonly Pairing[] = [
  { label: "master v rookie", white: "master", black: "rookie" },
  { label: "club v rookie", white: "club", black: "rookie" },
  { label: "club v master", white: "club", black: "master" },
];

export interface ComparisonRow {
  readonly pairing: string;
  readonly realMatches: number;
  readonly fastMatches: number;
  /** Share of matches the white player wins. */
  readonly realWin: number;
  readonly fastWin: number;
  readonly realPoints: number;
  readonly fastPoints: number;
  readonly realBoards: number;
  readonly fastBoards: number;
  readonly realFouls: number;
  readonly fastFouls: number;
  /** Differences, in percentage points for the win rate and percent otherwise. */
  readonly winGapPoints: number;
  readonly pointsGapPercent: number;
  readonly boardsGapPercent: number;
  readonly foulsGapPercent: number;
}

export interface ComparisonOptions {
  readonly pairings?: readonly Pairing[];
  readonly realMatchesPerPairing?: number;
  readonly fastMatchesPerPairing?: number;
  readonly seedPrefix?: string;
}

export interface ComparisonResult {
  readonly rows: readonly ComparisonRow[];
  readonly passed: boolean;
  /** What failed, in words, for the caller to print. */
  readonly failures: readonly string[];
}

/** Win rate, average total points, boards and fouls over a set of matches. */
interface Summary {
  readonly matches: number;
  readonly winWhite: number;
  readonly points: number;
  readonly boards: number;
  readonly fouls: number;
}

function summarise(matches: readonly MatchStats[]): Summary {
  let wins = 0;
  let points = 0;
  let boards = 0;
  let fouls = 0;

  for (const stats of matches) {
    if (stats.winner === "white") {
      wins += 1;
    }
    points += stats.totalPoints;
    boards += stats.boardsPlayed;
    fouls += stats.totalFouls;
  }

  const count = Math.max(1, matches.length);
  return {
    matches: matches.length,
    winWhite: wins / count,
    points: points / count,
    boards: boards / count,
    fouls: fouls / count,
  };
}

/** A skill profile for a bot level, as the odds engine sees it. */
export function skillOf(level: BotLevel): FastSkill {
  const skill = botSkill(level);
  return {
    aimErrorDegrees: skill.aimErrorDegrees,
    selectionQuality: skill.selectionQuality,
    foulRate: skill.foulRate,
  };
}

/**
 * Plays one whole match through the real engine and returns its stats.
 *
 * The room's referee is used as-is, with bot delays at zero and an in-memory
 * store, so this is the same code that plays a live match minus the network.
 */
export async function playRealMatch(
  white: BotLevel,
  black: BotLevel,
  seed: string,
): Promise<MatchStats> {
  const config = resolveConfig();
  const repository = new InMemoryMatchRepository();
  const seedCommit = commitOf(seed);
  const match = await repository.create({
    seedCommit,
    config: { carrom: config },
    seats: [
      { seat: 1, botLevel: white },
      { seat: 2, botLevel: black },
    ],
  });

  let settled: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    settled = resolve;
  });

  const runner = new CarromMatchRunner({
    matchId: match.id,
    seed,
    seedCommit,
    seats: runnerSeatsFromMatch(match),
    repository,
    config,
    botDelayMs: { min: 0, max: 0 },
    // start() returns once the match is live; the bots then play themselves out.
    hooks: {
      onEnd: () => {
        settled();
      },
    },
  });

  await runner.start();
  await finished;

  return computeMatchStats(match.id, await repository.listEvents(match.id));
}

/** Runs one pairing through both models. */
async function comparePairing(
  pairing: Pairing,
  realMatches: number,
  fastMatches: number,
  seedPrefix: string,
): Promise<ComparisonRow> {
  const real: MatchStats[] = [];
  for (let index = 0; index < realMatches; index += 1) {
    real.push(
      await playRealMatch(
        pairing.white,
        pairing.black,
        `${seedPrefix}:real:${pairing.label}:${String(index)}`,
      ),
    );
  }

  const fast: MatchStats[] = [];
  for (let index = 0; index < fastMatches; index += 1) {
    fast.push(
      simulateFastMatch({
        matchId: `${seedPrefix}:fast:${String(index)}`,
        seed: `${seedPrefix}:fast:${pairing.label}:${String(index)}`,
        white: {
          playerId: "white",
          displayName: `Bot ${pairing.white}`,
          isBot: true,
          skill: skillOf(pairing.white),
        },
        black: {
          playerId: "black",
          displayName: `Bot ${pairing.black}`,
          isBot: true,
          skill: skillOf(pairing.black),
        },
      }),
    );
  }

  const realSummary = summarise(real);
  const fastSummary = summarise(fast);

  const percent = (realValue: number, fastValue: number): number =>
    realValue === 0 ? 0 : ((fastValue - realValue) / realValue) * 100;

  return {
    pairing: pairing.label,
    realMatches: realSummary.matches,
    fastMatches: fastSummary.matches,
    realWin: realSummary.winWhite,
    fastWin: fastSummary.winWhite,
    realPoints: realSummary.points,
    fastPoints: fastSummary.points,
    realBoards: realSummary.boards,
    fastBoards: fastSummary.boards,
    realFouls: realSummary.fouls,
    fastFouls: fastSummary.fouls,
    winGapPoints: (fastSummary.winWhite - realSummary.winWhite) * 100,
    pointsGapPercent: percent(realSummary.points, fastSummary.points),
    boardsGapPercent: percent(realSummary.boards, fastSummary.boards),
    foulsGapPercent: percent(realSummary.fouls, fastSummary.fouls),
  };
}

export const WIN_TOLERANCE_POINTS = 2;
export const AVERAGE_TOLERANCE_PERCENT = 5;

/** Plays every pairing through both models and reports how far apart they are. */
export async function compareFastAndReal(
  options: ComparisonOptions = {},
): Promise<ComparisonResult> {
  const pairings = options.pairings ?? DEFAULT_PAIRINGS;
  const realMatches = options.realMatchesPerPairing ?? 40;
  const fastMatches = options.fastMatchesPerPairing ?? 2_000;
  const seedPrefix = options.seedPrefix ?? "validation";

  const rows: ComparisonRow[] = [];
  for (const pairing of pairings) {
    rows.push(await comparePairing(pairing, realMatches, fastMatches, seedPrefix));
  }

  const failures: string[] = [];
  for (const row of rows) {
    if (Math.abs(row.winGapPoints) > WIN_TOLERANCE_POINTS) {
      failures.push(
        `${row.pairing}: win probability off by ${row.winGapPoints.toFixed(1)} points (limit ${String(WIN_TOLERANCE_POINTS)})`,
      );
    }
    for (const [label, gap] of [
      ["points", row.pointsGapPercent],
      ["boards", row.boardsGapPercent],
      ["fouls", row.foulsGapPercent],
    ] as const) {
      if (Math.abs(gap) > AVERAGE_TOLERANCE_PERCENT) {
        failures.push(
          `${row.pairing}: average ${label} off by ${gap.toFixed(1)}% (limit ${String(AVERAGE_TOLERANCE_PERCENT)}%)`,
        );
      }
    }
  }

  return { rows, passed: failures.length === 0, failures };
}

/** The comparison as a fixed-width table, for a terminal or a test log. */
export function formatComparison(result: ComparisonResult): string {
  const header = [
    "pairing".padEnd(16),
    "win real".padStart(9),
    "win fast".padStart(9),
    "gap".padStart(7),
    "points".padStart(12),
    "boards".padStart(11),
    "fouls".padStart(11),
  ].join(" ");

  const lines = result.rows.map((row) =>
    [
      row.pairing.padEnd(16),
      `${(row.realWin * 100).toFixed(1)}%`.padStart(9),
      `${(row.fastWin * 100).toFixed(1)}%`.padStart(9),
      `${row.winGapPoints >= 0 ? "+" : ""}${row.winGapPoints.toFixed(1)}pp`.padStart(7),
      `${row.realPoints.toFixed(1)}/${row.fastPoints.toFixed(1)}`.padStart(12),
      `${row.realBoards.toFixed(2)}/${row.fastBoards.toFixed(2)}`.padStart(11),
      `${row.realFouls.toFixed(2)}/${row.fastFouls.toFixed(2)}`.padStart(11),
    ].join(" "),
  );

  return [header, ...lines].join("\n");
}
