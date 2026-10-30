/**
 * The spectator load test: five hundred people watching one match.
 *
 * `loadtest.ts` measures the public reads and the simulator. This measures the
 * other half of the load, the one a launch actually breaks on: a room fanning its
 * stream out to every spectator, over real WebSockets, on one process.
 *
 * What is measured, and why each number is worth having:
 *
 * 1. **Join**: how long five hundred spectators take to get into the room, per
 *    connection and in total. A slow tail here is a queue at kickoff.
 * 2. **Delivery**: for every broadcast, how many of the five hundred received it.
 *    A spectator who silently misses one frame is watching a different match.
 * 3. **Order**: whether each spectator's move numbers advance one at a time. A
 *    gap is a lost frame, and a repeat is a protocol bug; both are counted.
 * 4. **Fan-out spread**: for each broadcast, the gap between the first and last
 *    spectator to receive it. That is the cost of one-to-many on this machine.
 * 5. **Resident memory** before and after, because five hundred sockets is also
 *    five hundred buffers.
 *
 * Usage:
 *   npm run spectate:loadtest -- --spectators 500 --port 2610
 */

import { performance } from "node:perf_hooks";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import type { Room as SDKTypes } from "@colyseus/sdk";
import { z } from "zod";
import { commitOf, createMatchSeed } from "../src/lib/fair-rng.js";
import { InMemoryMatchRepository } from "../src/lib/match-repository.js";
import { LudoRoom, setLudoRoomDeps } from "../src/rooms/ludo-room.js";

const flagsSchema = z.object({
  spectators: z.coerce.number().int().min(1).max(2_000).default(500),
  port: z.coerce.number().int().min(1).max(65_535).default(2_610),
  /** How many broadcasts every spectator has to see before the run is judged. */
  moves: z.coerce.number().int().min(5).max(2_000).default(40),
  connectBatch: z.coerce.number().int().min(1).max(500).default(50),
});

type Flags = z.infer<typeof flagsSchema>;

function parseFlags(argv: readonly string[]): Flags {
  const raw: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      raw[name] = "true";
      continue;
    }
    raw[name] = value;
    index += 1;
  }
  const parsed = flagsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`invalid flags:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What one spectator saw. */
interface Watcher {
  readonly index: number;
  readonly joinMs: number;
  readonly received: Map<number, number>;
  readonly moves: number[];
  gaps: number;
  repeats: number;
  /** Frames this viewer was told it missed because its socket was behind. */
  declaredSkips: number;
}

interface Broadcast {
  readonly moveNumber: number;
  firstAt: number;
  lastAt: number;
  count: number;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const repository = new InMemoryMatchRepository();
  setLudoRoomDeps({
    repository,
    verifyUser: async () => null,
    // A tick per turn rather than the room's real one to three seconds: the point
    // is the fan-out, not how long four bots take to think.
    botDelayMs: { min: 2, max: 6 },
    reconnectionSeconds: 1,
  });

  const config = {
    initializeGameServer: (gameServer: { define: (name: string, room: typeof LudoRoom) => void }) => {
      gameServer.define("ludo", LudoRoom);
    },
  };

  const colyseus: ColyseusTestServer = await boot(
    config as unknown as Parameters<typeof boot>[0],
    flags.port,
  );

  const seed = createMatchSeed();
  const match = await repository.create({
    game: "ludo",
    seedCommit: commitOf(seed),
    seats: [
      { seat: 1, botLevel: "club", botPolicy: "cautious", displayName: "Cautious Bot" },
      { seat: 2, botLevel: "club", botPolicy: "aggressive", displayName: "Aggressive Bot" },
      { seat: 3, botLevel: "club", botPolicy: "racer", displayName: "Racer Bot" },
      { seat: 4, botLevel: "club", botPolicy: "cautious", displayName: "Steady Bot" },
    ],
    config: { ludo: { players: 4 } },
  });

  const room = await colyseus.createRoom<LudoRoom>("ludo", {
    matchId: match.id,
    seed,
    allowSpectators: true,
  });

  const broadcasts = new Map<number, Broadcast>();
  const watchers: Watcher[] = [];
  const failures: string[] = [];
  const memoryBefore = process.memoryUsage().rss;

  const watch = (index: number, client: SDKTypes, joinMs: number): Watcher => {
    const watcher: Watcher = {
      index,
      joinMs,
      received: new Map<number, number>(),
      moves: [],
      gaps: 0,
      repeats: 0,
      declaredSkips: 0,
    };
    client.onMessage("*", (type: string | number, payload: unknown) => {
      const at = performance.now();
      const name = String(type);
      // A viewer whose socket fell behind is skipped on purpose and told how much
      // it missed. That is the designed behaviour for a slow consumer, so it is
      // counted separately from a frame that vanished without notice.
      if (name === "lag") {
        const lag = payload as { skippedShots?: unknown };
        if (typeof lag.skippedShots === "number") {
          watcher.declaredSkips += lag.skippedShots;
        }
        return;
      }
      // `roll` and `move` both carry a moveNumber for the same turn, so counting
      // both would read as 200% delivery and 2,000 reordered frames. The board
      // message is the broadcast every spectator must receive.
      if (name !== "move") {
        return;
      }
      const body = payload as { moveNumber?: unknown };
      const moveNumber = typeof body.moveNumber === "number" ? body.moveNumber : null;
      if (moveNumber === null) {
        return;
      }
      const seen = watcher.received.get(moveNumber) ?? 0;
      watcher.received.set(moveNumber, seen + 1);
      if (seen === 0) {
        watcher.moves.push(moveNumber);
      } else {
        watcher.repeats += 1;
      }
      const existing = broadcasts.get(moveNumber);
      if (existing === undefined) {
        broadcasts.set(moveNumber, { moveNumber, firstAt: at, lastAt: at, count: 1 });
      } else {
        existing.lastAt = Math.max(existing.lastAt, at);
        existing.count += 1;
      }
    });
    return watcher;
  };

  const joinStartedAt = performance.now();

  // Batches keep the connect spike honest: five hundred simultaneous handshakes
  // measure the backlog, not the fan-out.
  for (let start = 0; start < flags.spectators; start += flags.connectBatch) {
    const size = Math.min(flags.connectBatch, flags.spectators - start);
    const batch = await Promise.all(
      Array.from({ length: size }, async (_, offset) => {
        const index = start + offset;
        const startedAt = performance.now();
        try {
          const client = await colyseus.sdk.joinById(room.roomId, { spectate: true });
          const joinMs = performance.now() - startedAt;
          return { index, client, joinMs };
        } catch (error) {
          failures.push(
            `spectator ${String(index)}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      }),
    );
    for (const joined of batch) {
      if (joined !== null) {
        watchers.push(watch(joined.index, joined.client, joined.joinMs));
      }
    }
  }

  const joinedAt = performance.now();

  // Only what is broadcast after the last spectator is settled can be owed to
  // every spectator. Two things happen at a join: the viewer was never meant to
  // see the moves from before it arrived, and until its snapshot lands the hub
  // holds its frames back as `pending`. Measuring through that window counts the
  // join handshake as packet loss, so the window is allowed to close first.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const measureFrom = Math.max(0, ...broadcasts.keys());

  const deadline = Date.now() + 120_000;
  while (
    [...broadcasts.keys()].filter((moveNumber) => moveNumber > measureFrom).length < flags.moves &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // The last broadcast is still in flight when the counter is satisfied. A short
  // settle keeps the tail of the fan-out from being scored as a lost frame.
  await new Promise((resolve) => setTimeout(resolve, 1_200));

  const memoryAfter = process.memoryUsage().rss;
  const expected = [...broadcasts.keys()]
    .filter((moveNumber) => moveNumber > measureFrom)
    .sort((left, right) => left - right)
    .slice(0, flags.moves);
  const target = expected[expected.length - 1] ?? measureFrom;
  for (const watcher of watchers) {
    const seen = new Set(watcher.moves.filter((moveNumber) => moveNumber > measureFrom));
    for (const moveNumber of expected) {
      if (!seen.has(moveNumber)) {
        watcher.gaps += 1;
      }
    }
    for (let index = 1; index < watcher.moves.length; index += 1) {
      const previous = watcher.moves[index - 1] ?? 0;
      const current = watcher.moves[index] ?? 0;
      if (current < previous) {
        watcher.repeats += 1;
      }
    }
  }

  const joinTimes = watchers.map((watcher) => watcher.joinMs).sort((left, right) => left - right);
  const spreads = expected
    .map((moveNumber) => broadcasts.get(moveNumber))
    .filter((entry): entry is Broadcast => entry !== undefined)
    .map((entry) => entry.lastAt - entry.firstAt)
    .sort((left, right) => left - right);
  const coverage = expected
    .map((moveNumber) => {
      const entry = broadcasts.get(moveNumber);
      return entry === undefined ? 0 : entry.count / Math.max(1, watchers.length);
    })
    .sort((left, right) => left - right);
  const totalGaps = watchers.reduce((sum, watcher) => sum + watcher.gaps, 0);
  const declaredSkips = watchers.reduce((sum, watcher) => sum + watcher.declaredSkips, 0);
  const silentGaps = Math.max(0, totalGaps - declaredSkips);
  const missedByMove = new Map<number, number>();
  for (const watcher of watchers) {
    const seen = new Set(watcher.moves.filter((moveNumber) => moveNumber > measureFrom));
    for (const moveNumber of expected) {
      if (!seen.has(moveNumber)) {
        missedByMove.set(moveNumber, (missedByMove.get(moveNumber) ?? 0) + 1);
      }
    }
  }
  const totalRepeats = watchers.reduce((sum, watcher) => sum + watcher.repeats, 0);
  const connectSeconds = (joinedAt - joinStartedAt) / 1000;

  console.log("");
  console.log(`spectators    ${String(watchers.length)} connected of ${String(flags.spectators)} requested`);
  console.log(`failures      ${String(failures.length)}${failures[0] === undefined ? "" : `, first: ${failures[0]}`}`);
  console.log(`join total    ${connectSeconds.toFixed(2)} s for ${String(watchers.length)} spectators`);
  console.log(`join p50      ${percentile(joinTimes, 0.5).toFixed(1)} ms`);
  console.log(`join p95      ${percentile(joinTimes, 0.95).toFixed(1)} ms`);
  console.log(`join p99      ${percentile(joinTimes, 0.99).toFixed(1)} ms`);
  console.log(`join max      ${(joinTimes[joinTimes.length - 1] ?? 0).toFixed(1)} ms`);
  console.log("");
  console.log(`broadcasts    ${String(expected.length)} measured, up to move ${String(target)}`);
  console.log(`delivery p50  ${(percentile(coverage, 0.5) * 100).toFixed(1)}% of spectators per broadcast`);
  console.log(`delivery min  ${((coverage[0] ?? 0) * 100).toFixed(1)}%`);
  console.log(`fan-out p50   ${percentile(spreads, 0.5).toFixed(2)} ms`);
  console.log(`fan-out p95   ${percentile(spreads, 0.95).toFixed(2)} ms`);
  console.log(`fan-out max   ${(spreads[spreads.length - 1] ?? 0).toFixed(2)} ms`);
  const worstMoves = [...missedByMove.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([moveNumber, count]) => `move ${String(moveNumber)}×${String(count)}`)
    .join(" ");
  console.log(
    `gaps          ${String(totalGaps)} missed broadcasts across every spectator${worstMoves === "" ? "" : ` (${worstMoves})`}`,
  );
  console.log(
    `delivery      ${(((expected.length * watchers.length - totalGaps) / Math.max(1, expected.length * watchers.length)) * 100).toFixed(3)}% of all owed frames arrived`,
  );
  console.log(`repeats       ${String(totalRepeats)} reordered frames`);
  console.log(`declared lag  ${String(declaredSkips)} frames skipped for slow sockets, reported to them`);
  console.log(`silent gaps   ${String(silentGaps)} frames lost with no notice`);
  console.log("");
  console.log(`memory        ${megabytes(memoryBefore)} before, ${megabytes(memoryAfter)} with ${String(watchers.length)} sockets`);

  const healthy =
    failures.length === 0 &&
    silentGaps === 0 &&
    totalRepeats === 0 &&
    watchers.length === flags.spectators;
  console.log("");
  console.log(
    healthy
      ? `PASS ${String(watchers.length)} spectators, every frame delivered or reported as skipped, none out of order`
      : "FAIL the run lost spectators, lost frames silently, or reordered them",
  );

  await colyseus.shutdown();
  setLudoRoomDeps(null);
  if (!healthy) {
    process.exitCode = 1;
  }
}

await main();
