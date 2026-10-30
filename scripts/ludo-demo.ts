import { commitOf, createMatchSeed } from "../src/lib/fair-rng.js";
import { InMemoryMatchRepository } from "../src/lib/match-repository.js";
import { verifyMatch } from "../src/lib/match-verify.js";
import { logger } from "../src/lib/logger.js";
import { LudoMatchRunner, type LudoRunnerSeat } from "../src/rooms/ludo-match-runner.js";

/**
 * npm run ludo:demo
 *
 * Plays a whole four bot Ludo match with the published policies, prints how it
 * ended, then verifies it with the same verifier `npm run verify-match` uses and
 * prints PASS. Last, it tampers with one recorded roll and shows the verifier
 * catching it, so the PASS is not taken on trust.
 *
 * It runs in memory: no database, no network, no Supabase credentials needed.
 */

const POLICY: readonly { readonly seat: 1 | 2 | 3 | 4; readonly policy: string }[] = [
  { seat: 1, policy: "cautious" },
  { seat: 2, policy: "aggressive" },
  { seat: 3, policy: "racer" },
  { seat: 4, policy: "cautious" },
];

async function main(): Promise<number> {
  const repository = new InMemoryMatchRepository();
  const seed = createMatchSeed();
  const match = await repository.create({
    game: "ludo",
    seedCommit: commitOf(seed),
    seats: POLICY.map((entry) => ({
      seat: entry.seat,
      botLevel: "club" as const,
      botPolicy: entry.policy,
    })),
    config: { ludo: { players: 4 } },
  });

  const seats: LudoRunnerSeat[] = [...match.seats]
    .sort((left, right) => left.seat - right.seat)
    .map((seat) => ({
      seat: seat.seat,
      playerId: seat.playerId,
      displayName: seat.displayName,
      isBot: seat.isBot,
      botPolicy: seat.botPolicy,
      profileId: seat.profileId,
    }));

  console.log(`match ${match.id}, four bots, seed committed before play`);

  let finished: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => {
    finished = resolve;
  });

  const runner = new LudoMatchRunner({
    matchId: match.id,
    seed,
    seedCommit: commitOf(seed),
    seats,
    repository,
    config: { players: 4 },
    // The room waits one to three seconds per bot; the demo cannot.
    botDelayMs: { min: 0, max: 1 },
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
    logger: logger.child({ demo: "ludo" }),
    hooks: {
      onEnd: () => {
        finished?.();
      },
    },
  });

  const started = Date.now();
  await runner.start();
  await ended;
  const elapsed = Date.now() - started;

  const stored = await repository.get(match.id);
  const result = stored?.result;
  console.log(
    `finished in ${String(result?.shots)} moves (${elapsed} ms, ${String(result?.seedDraws)} die rolls)`,
  );
  console.log(`finishing order: ${(result?.finishingOrder ?? []).join(", ")}`);
  console.log(`tokens home:     ${(result?.tokensHome ?? []).join(", ")}`);
  console.log("");

  const report = await verifyMatch(match.id, repository);
  for (const check of report.checks) {
    const where = check.seq === undefined ? "" : ` (at event ${check.seq})`;
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${where}${check.detail === undefined ? "" : `: ${check.detail}`}`);
  }

  if (!report.ok) {
    console.log(`FAIL ${match.id}: ${report.failure ?? "verification failed"}`);
    return 1;
  }
  console.log(
    `PASS ${match.id}: ${String(report.shots)} turns replayed, chain, result and signature intact`,
  );

  // Now break it on purpose: change one recorded roll and verify again.
  const events = await repository.listEvents(match.id);
  const target = events.find((entry) => entry.type === "turn");
  if (target === undefined) {
    console.log("could not find a turn to tamper with");
    return 1;
  }

  const tampered = { ...target, payload: { ...target.payload, roll: 7 } };
  const originalList = repository.listEvents.bind(repository);
  repository.listEvents = async (matchId: string) =>
    (await originalList(matchId)).map((entry) =>
      entry.seq === tampered.seq ? tampered : entry,
    );

  const broken = await verifyMatch(match.id, repository);
  repository.listEvents = originalList;

  console.log("");
  console.log(
    `${broken.ok ? "FAIL" : "ok  "} tampering with a recorded roll: ${broken.failure ?? "not detected"}`,
  );

  return broken.ok ? 1 : 0;
}

process.exitCode = await main();
