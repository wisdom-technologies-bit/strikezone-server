import { DEFAULT_PAIRINGS, playRealMatch, skillOf, type Pairing } from "../src/odds/validation.js";
import {
  DEFAULT_TUNING,
  simulateFastMatch,
  type FastTuning,
} from "../src/odds/carrom-fast-model.js";

/**
 * npm run odds:fit -- [realMatches] [fastMatches]
 *
 * Fits the fast model's constants to the real engine.
 *
 * The real matches are played once; the sweep is fast-only, so the expensive
 * half is paid a single time. Prints the best set and the table it produces, and
 * the constants it prints are the ones in DEFAULT_TUNING when they agree.
 */
interface RealSummary {
  readonly pairing: Pairing;
  readonly win: number;
  readonly points: number;
  readonly boards: number;
  readonly fouls: number;
}

async function main(): Promise<void> {
  const realMatches = Number(process.argv[2] ?? 60);
  const fastMatches = Number(process.argv[3] ?? 1_000);

  console.log(`playing ${String(realMatches)} real matches per pairing`);
  const real: RealSummary[] = [];

  for (const pairing of DEFAULT_PAIRINGS) {
    let wins = 0;
    let points = 0;
    let boards = 0;
    let fouls = 0;

    for (let index = 0; index < realMatches; index += 1) {
      const stats = await playRealMatch(
        pairing.white,
        pairing.black,
        `fit:${pairing.label}:${String(index)}`,
      );
      wins += stats.winner === "white" ? 1 : 0;
      points += stats.totalPoints;
      boards += stats.boardsPlayed;
      fouls += stats.totalFouls;
    }

    const count = Math.max(1, realMatches);
    real.push({
      pairing,
      win: wins / count,
      points: points / count,
      boards: boards / count,
      fouls: fouls / count,
    });
    console.log(
      `  ${pairing.label.padEnd(16)} win ${((wins / count) * 100).toFixed(1)}%  points ${(points / count).toFixed(1)}  boards ${(boards / count).toFixed(2)}  fouls ${(fouls / count).toFixed(2)}`,
    );
  }

  const fast = (
    tuning: FastTuning,
  ): { win: number; points: number; boards: number; fouls: number }[] => {
    return real.map((entry) => {
      let wins = 0;
      let points = 0;
      let boards = 0;
      let fouls = 0;
      for (let index = 0; index < fastMatches; index += 1) {
        const stats = simulateFastMatch({
          matchId: `fit-${String(index)}`,
          seed: `fit:${entry.pairing.label}:${String(index)}`,
          white: {
            playerId: "w",
            displayName: "W",
            isBot: true,
            skill: skillOf(entry.pairing.white),
          },
          black: {
            playerId: "b",
            displayName: "B",
            isBot: true,
            skill: skillOf(entry.pairing.black),
          },
          tuning,
        });
        wins += stats.winner === "white" ? 1 : 0;
        points += stats.totalPoints;
        boards += stats.boardsPlayed;
        fouls += stats.totalFouls;
      }
      const count = Math.max(1, fastMatches);
      return {
        win: wins / count,
        points: points / count,
        boards: boards / count,
        fouls: fouls / count,
      };
    });
  };

  const score = (tuning: FastTuning): number => {
    const rows = fast(tuning);
    let worst = 0;
    for (const [index, row] of rows.entries()) {
      const target = real[index];
      if (target === undefined) continue;
      const winGap = Math.abs((row.win - target.win) * 100);
      const pointsGap =
        target.points === 0 ? 0 : Math.abs((row.points - target.points) / target.points) * 100;
      const boardsGap =
        target.boards === 0 ? 0 : Math.abs((row.boards - target.boards) / target.boards) * 100;
      worst = Math.max(worst, winGap, pointsGap, boardsGap);
    }
    return worst;
  };

  const floors = [0.2, 0.3, 0.4];
  const weights = [0.6, 0.7, 0.8];
  const exponents = [5, 6, 7];
  const foulScales = [0.35, 0.5];
  const flukes = [0.12, 0.16];

  let best: { tuning: FastTuning; error: number } = {
    tuning: DEFAULT_TUNING,
    error: Number.POSITIVE_INFINITY,
  };

  for (const selectionFloor of floors) {
    for (const selectionWeight of weights) {
      for (const qualityExponent of exponents) {
        for (const foulScale of foulScales) {
          for (const flukeRate of flukes) {
            const tuning: FastTuning = {
              selectionFloor,
              selectionWeight,
              qualityExponent,
              foulScale,
              flukeRate,
            };
            const error = score(tuning);
            if (error < best.error) {
              best = { tuning, error };
            }
          }
        }
      }
    }
  }

  console.log("\nbest constants, worst error " + best.error.toFixed(1) + "%");
  console.log(JSON.stringify(best.tuning, null, 2));

  const rows = fast(best.tuning);
  for (const [index, row] of rows.entries()) {
    const target = real[index];
    if (target === undefined) continue;
    console.log(
      `${target.pairing.label.padEnd(16)} win ${(target.win * 100).toFixed(1)}/${(row.win * 100).toFixed(1)}  points ${target.points.toFixed(1)}/${row.points.toFixed(1)}  boards ${target.boards.toFixed(2)}/${row.boards.toFixed(2)}  fouls ${target.fouls.toFixed(2)}/${row.fouls.toFixed(2)}`,
    );
  }
}

void main();
