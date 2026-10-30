import { supabase } from "../src/lib/supabase.js";
import { matchRepository } from "../src/lib/match-store.js";
import { runBacktest } from "../src/odds/backtest.js";
import type { MatchLogEntry } from "../src/lib/match-log.js";
import type { MatchRecord } from "../src/lib/match-repository.js";

/**
 * npm run odds:backtest -- [matches] [simulations]
 *
 * Scores the model against matches that really finished: it reads finished
 * matches from the database, re-simulates the same pairing, and prints the
 * calibration table. Predicted and observed should agree inside each bucket.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. The odds engine reads
 * finished matches and writes nothing here.
 */
async function main(): Promise<number> {
  const limit = Number(process.argv[2] ?? "200");
  const simulations = Number(process.argv[3] ?? "2000");

  if (
    !Number.isInteger(limit) ||
    limit <= 0 ||
    !Number.isInteger(simulations) ||
    simulations <= 0
  ) {
    console.error("usage: npm run odds:backtest -- [matches] [simulations]");
    return 2;
  }

  const { data, error } = await supabase
    .from("matches")
    .select("id")
    .eq("status", "finished")
    .order("created_date", { ascending: false })
    .limit(limit);

  if (error !== null) {
    console.error(`could not read finished matches: ${error.message}`);
    return 1;
  }

  const ids = (data ?? []).map((row: unknown) => String((row as { id: unknown }).id));
  if (ids.length === 0) {
    console.log("no finished matches yet: play some, then run this again");
    return 0;
  }

  const repository = matchRepository();
  const loaded: { match: MatchRecord; events: readonly MatchLogEntry[] }[] = [];

  for (const id of ids) {
    const match = await repository.get(id);
    if (match === null) {
      continue;
    }
    loaded.push({ match, events: await repository.listEvents(id) });
  }

  const report = await runBacktest({
    simulations,
    loadMatches: () => Promise.resolve(loaded),
  });

  console.log(
    `backtest over ${String(report.matches)} matches, ${String(report.samples)} claims\n`,
  );
  console.log("bucket      predicted  observed    gap   count");
  for (const row of report.rows) {
    console.log(
      `${row.label.padEnd(10)} ${(row.predicted * 100).toFixed(1).padStart(8)}% ` +
        `${(row.observed * 100).toFixed(1).padStart(8)}% ` +
        `${(row.error * 100).toFixed(1).padStart(6)}pp ${String(row.count).padStart(6)}`,
    );
  }
  console.log(
    `\nbrier ${report.brier.toFixed(4)}  worst bucket error ${(report.worstError * 100).toFixed(1)}pp`,
  );

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
