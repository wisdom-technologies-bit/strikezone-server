import { resolveConfig } from "../src/engines/carrom/config.js";
import { publish, subscribe } from "../src/lib/events.js";
import { commitOf, createMatchSeed } from "../src/lib/fair-rng.js";
import { matchRepository } from "../src/lib/match-store.js";
import { CarromMatchRunner, runnerSeatsFromMatch } from "../src/rooms/carrom-match-runner.js";
import { attachOddsEngine } from "../src/odds/live.js";
import { marketsRepository } from "../src/odds/markets-store.js";

/**
 * End to end, against the real database: a bot-versus-bot match is created, the
 * odds engine prices it, the match is played with a shot event per shot, and the
 * whole thing ends with a settlement notification. Prints what landed in the
 * markets table so the DONE WHEN can be checked rather than assumed.
 */
const config = resolveConfig();
const seed = createMatchSeed();
const seedCommit = commitOf(seed);
const repository = matchRepository();
const markets = marketsRepository();

const notices: string[] = [];
const off = subscribe("markets.ready_to_settle", (payload) => {
  notices.push(
    `ready_to_settle ${payload.matchId} winner=${String(payload.winner)} boards=${payload.boardsPlayed}`,
  );
});

// A reprice is 5,000 simulated matches plus a 231-row write, so the throttle is
// what keeps the match itself from being starved by its own prices.
const engine = attachOddsEngine({ repository: markets, repriceIntervalMs: 2500 });

const match = await repository.create({
  seedCommit,
  config: { carrom: config },
  seats: [
    { seat: 1, botLevel: "club" },
    { seat: 2, botLevel: "rookie" },
  ],
});

const payloadBase = {
  matchId: match.id,
  game: "carrom" as const,
  tournamentId: null,
};

const startedAt = Date.now();
publish("match.created", {
  ...payloadBase,
  playerIds: match.seats.map((seat) => seat.playerId),
  isBot: match.seats.map((seat) => seat.isBot),
});
await engine.idle();

const priced = await markets.listForMatch(match.id);
console.log(`priced ${String(priced.length)} rows in ${String(Date.now() - startedAt)}ms`);
console.log(`  types: ${String(new Set(priced.map((row) => row.marketType)).size)}`);
console.log(`  statuses: ${JSON.stringify(statusCount(priced))}`);

publish("match.live", { ...payloadBase, startedAt: new Date().toISOString() });
await engine.idle();

let shots = 0;
let finished = false;
const done = new Promise<void>((resolve) => {
  const off = subscribe("markets.ready_to_settle", () => {
    off();
    resolve();
  });
});

const runner = new CarromMatchRunner({
  matchId: match.id,
  seed,
  seedCommit,
  seats: runnerSeatsFromMatch(match),
  repository,
  config,
  botDelayMs: { min: 2, max: 3 },
  hooks: {
    onShot: (shot) => {
      shots += 1;
      publish("match.shot", { ...payloadBase, seat: shot.seat, shotNumber: shot.shotNumber });
    },
    onEnd: (result) => {
      finished = true;
      publish("match.finished", {
        ...payloadBase,
        winnerPlayerId:
          match.seats.find((seat) => seat.seat === result.winnerSeat)?.playerId ?? null,
        loserPlayerId:
          match.seats.find((seat) => seat.seat !== result.winnerSeat)?.playerId ?? null,
        reason: result.reason,
        scores: { white: result.scores.white, black: result.scores.black },
      });
    },
  },
});

const playedAt = Date.now();
await runner.start();
await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 240_000))]);
await engine.idle();

const finalRows = await markets.listForMatch(match.id);
console.log(
  `played ${String(shots)} shots in ${String(Date.now() - playedAt)}ms, finished=${String(finished)}`,
);
console.log(
  `  rows now: ${String(finalRows.length)}, statuses: ${JSON.stringify(statusCount(finalRows))}`,
);
console.log(`  notices: ${notices.join("; ") || "none"}`);

off();
engine.stop();

function statusCount(rows: readonly { status: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}
