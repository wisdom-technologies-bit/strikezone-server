import { compareFastAndReal, formatComparison } from "../src/odds/validation.js";

/**
 * npm run odds:validate -- [realMatches] [fastMatches]
 *
 * Plays every pairing through the real engine and through the fast model, and
 * prints the comparison. Exits 1 if any gap is outside tolerance, so it can gate
 * a release the same way the tests gate a commit.
 */
async function main(): Promise<number> {
  const realMatches = Number(process.argv[2] ?? 200);
  const fastMatches = Number(process.argv[3] ?? 5_000);

  console.log(
    `playing ${String(realMatches)} real matches and ${String(fastMatches)} fast ones per pairing`,
  );
  const result = await compareFastAndReal({
    realMatchesPerPairing: realMatches,
    fastMatchesPerPairing: fastMatches,
  });

  console.log(formatComparison(result));

  if (!result.passed) {
    console.error("\noutside tolerance:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    return 1;
  }

  console.log("\nwithin tolerance");
  return 0;
}

void main().then((code) => {
  process.exitCode = code;
});
