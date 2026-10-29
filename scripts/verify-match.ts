import { SupabaseMatchRepository } from "../src/lib/match-repository.js";
import { verifyMatch } from "../src/lib/match-verify.js";

/**
 * npm run verify-match -- <matchId>
 *
 * Re-checks a finished match from the database alone: the seed against its
 * commitment, the hash chain, every shot replayed through the engine, the final
 * score against the signed result, and the signature itself.
 *
 * Prints one line per check and then PASS, or the first mismatch and then FAIL.
 * Exit code 0 means the match verified, 1 means it did not, 2 means it was used
 * wrongly.
 */
async function main(): Promise<number> {
  const matchId = process.argv[2];

  if (matchId === undefined || matchId.trim() === "") {
    console.error("usage: npm run verify-match -- <matchId>");
    return 2;
  }

  const report = await verifyMatch(matchId, new SupabaseMatchRepository());

  for (const check of report.checks) {
    const where = check.seq === undefined ? "" : ` (at event ${check.seq})`;
    const state = check.ok ? "ok  " : "FAIL";
    const detail = check.detail === undefined ? "" : `: ${check.detail}`;
    console.log(`${state} ${check.name}${where}${detail}`);
  }

  if (report.ok) {
    console.log(
      `PASS ${matchId}: ${report.shots} shots replayed, chain, result and signature intact`,
    );
    return 0;
  }

  console.log(`FAIL ${matchId}: ${report.failure ?? "verification failed"}`);
  return 1;
}

process.exitCode = await main();
