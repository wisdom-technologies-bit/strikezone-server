import { boot } from "@colyseus/testing";
import type { Room as SDKTypes } from "@colyseus/sdk";
import {
  decodeFrames,
  frameBodies,
  type ShotMessage,
  type SnapshotMessage,
} from "../src/api/contract.js";
import { commitOf, createMatchSeed } from "../src/lib/fair-rng.js";
import { InMemoryMatchRepository } from "../src/lib/match-repository.js";
import { CarromRoom, setCarromRoomDeps } from "../src/rooms/carrom-room.js";

/**
 * npm run watch:demo
 *
 * The spectator stream, end to end, without a browser: boot a real Colyseus
 * server, start a bot match, join it as an anonymous spectator the way
 * /dev/watch.html does, and decode the frames that arrive. It prints the motion a
 * viewer would see and the bandwidth a shot costs.
 *
 * The match store is in memory and the port is throwaway, so it needs no keys and
 * leaves nothing behind. The room, the stream and the decoder are the real ones.
 */

const BODIES_TO_WATCH = ["striker"];

function heading(text: string): void {
  process.stdout.write(`\n${text}\n${"-".repeat(text.length)}\n`);
}

function row(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(30)} ${value}\n`);
}

interface Logged {
  readonly type: string;
  readonly payload: unknown;
}

/**
 * One wildcard handler, attached before anything is awaited.
 *
 * The client flushes whatever arrived before its first handler at the moment that
 * handler is registered, so a handler added later misses the stream's first
 * messages. A real viewer has to listen from the first moment; so does this.
 */
function collectAll(client: SDKTypes): Logged[] {
  const log: Logged[] = [];
  client.onMessage("*", (type: string | number, payload: unknown) => {
    log.push({ type: String(type), payload });
  });
  return log;
}

/** Waits until the log holds a message of this type. */
async function waitFor<T>(log: readonly Logged[], type: string, timeoutMs = 10_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = log.find((entry) => entry.type === type);
    if (found !== undefined) {
      return found.payload as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no "${type}" within ${timeoutMs} ms`);
}

async function main(): Promise<number> {
  const repository = new InMemoryMatchRepository();
  setCarromRoomDeps({
    repository,
    verifyUser: async () => null,
    botDelayMs: { min: 200, max: 300 },
    reconnectionSeconds: 1,
  });

  const server = await boot(
    {
      initializeGameServer: (gameServer: { define: (name: string, room: typeof CarromRoom) => void }) => {
        gameServer.define("carrom", CarromRoom);
      },
    } as unknown as Parameters<typeof boot>[0],
    2601,
  );

  const seed = createMatchSeed();
  const match = await repository.create({
    seedCommit: commitOf(seed),
    seats: [
      { seat: 1, botLevel: "club" },
      { seat: 2, botLevel: "rookie" },
    ],
    config: { turnSeconds: 30 },
  });

  const room = await server.createRoom<CarromRoom>("carrom", { matchId: match.id, seed });

  heading("1. A spectator joins, anonymously");
  const spectator = await server.sdk.joinById(room.roomId, { spectate: true });
  const log = collectAll(spectator);
  const welcome = await waitFor<{ matchId: string; spectators: number; fps: number }>(log, "welcome");
  row("match", welcome.matchId);
  row("spectators", String(welcome.spectators));
  row("tick rate", `${String(welcome.fps)} fps`);

  const snapshot = await waitFor<SnapshotMessage>(log, "snapshot");
  row("snapshot board", String(snapshot.board));
  row("snapshot shot number", String(snapshot.shotNumber));
  row("bodies on the board", String(snapshot.coins.length));

  heading("2. Shots arrive, with frames");
  const startedAt = Date.now();
  while (
    log.filter((entry) => entry.type === "shot").length < 3 &&
    Date.now() - startedAt < 30_000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const shots = log
    .filter((entry) => entry.type === "shot")
    .map((entry) => entry.payload as ShotMessage);

  if (shots.length < 3) {
    process.stderr.write(`only ${String(shots.length)} shot(s) arrived\n`);
    return 1;
  }

  for (const shot of shots) {
    const decoded = decodeFrames(shot.frames);
    const first = decoded.frameCount > 0 ? frameBodies(decoded, 0) : [];
    const last = decoded.frameCount > 0 ? frameBodies(decoded, decoded.frameCount - 1) : [];
    const strikerStart = first.find((body) => body.id === "striker");
    const strikerEnd = last.find((body) => body.id === "striker");
    const travelled =
      strikerStart !== undefined && strikerEnd !== undefined
        ? Math.hypot(strikerEnd.x - strikerStart.x, strikerEnd.y - strikerStart.y)
        : 0;

    row(
      `shot ${String(shot.shotNumber)}`,
      `${String(shot.frames.frameCount)} frames, ${String(decoded.bodyIds.length)} bodies, ` +
        `${String(shot.frames.data.length)} bytes, striker moved ${travelled.toFixed(1)} mm, ` +
        `${String(shot.events.length)} event(s)`,
    );
  }

  heading("3. What a viewer is given");
  const totalBytes = shots.reduce((sum, shot) => sum + shot.frames.data.length, 0);
  const totalFrames = shots.reduce((sum, shot) => sum + shot.frames.frameCount, 0);
  row("frames decoded", String(totalFrames));
  row("base64 bytes", String(totalBytes));
  row("bytes per frame", (totalBytes / Math.max(1, totalFrames)).toFixed(1));
  row("internal bodies per frame", String(shots[0]?.frames.bodyIds.length ?? 0));

  const striker = shots[0] === undefined ? null : decodeFrames(shots[0].frames);
  if (striker !== null && striker.frameCount > 2) {
    const path = [0, 1, 2, 3, 4].map((index) => {
      const body = frameBodies(striker, index).find((candidate) => candidate.id === "striker");
      return body === undefined ? "(absent)" : `${body.x.toFixed(0)},${body.y.toFixed(0)}`;
    });
    row("striker, first frames (mm)", path.join(" -> "));
  }
  void BODIES_TO_WATCH;

  await spectator.leave();

  heading("Result");
  const smooth = totalFrames >= 3 * 10 && (shots[0]?.frames.frameCount ?? 0) > 10;
  process.stdout.write(
    smooth
      ? "  The stream delivers a snapshot and then a recorded shot at 30 fps, and every frame\n  decodes to millimetres on the board. /dev/watch.html draws exactly these frames.\n\n"
      : "  THE STREAM DID NOT DELIVER A RECORDING. See the counts above.\n\n",
  );

  return smooth ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`the demo failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    setCarromRoomDeps(null);
    // The socket server would otherwise keep the process alive.
    setTimeout(() => {
      process.exit(process.exitCode ?? 0);
    }, 250).unref();
  });
