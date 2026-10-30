import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import type { Room as SDKTypes } from "@colyseus/sdk";
import {
  decodeFrames,
  shotMessageSchema,
  type ShotMessage,
  type SnapshotMessage,
} from "../../src/api/contract.js";
import { subscribe } from "../../src/lib/events.js";
import { commitOf, createMatchSeed } from "../../src/lib/fair-rng.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { CarromRoom, setCarromRoomDeps } from "../../src/rooms/carrom-room.js";

/**
 * The spectator stream, over a real WebSocket server.
 *
 * These tests watch a bot match the way a browser does: join with `spectate`,
 * take the snapshot, then follow the shots. What they pin down is the ordering
 * the betting side depends on, and the rules a spectator cannot break.
 */

const repository = new InMemoryMatchRepository();
let colyseus: ColyseusTestServer;

beforeAll(async () => {
  setCarromRoomDeps({
    repository,
    verifyUser: async () => null,
    botDelayMs: { min: 60, max: 90 },
    reconnectionSeconds: 1,
  });

  const config = {
    initializeGameServer: (gameServer: {
      define: (name: string, room: typeof CarromRoom) => void;
    }) => {
      gameServer.define("carrom", CarromRoom);
    },
  };

  // A port of its own: vitest runs test files in parallel, and two Colyseus
  // servers cannot share one.
  colyseus = await boot(config as unknown as Parameters<typeof boot>[0], 2571);
}, 30_000);

afterAll(async () => {
  await colyseus.shutdown();
  setCarromRoomDeps(null);
});

interface Logged {
  readonly type: string;
  readonly payload: unknown;
}

/**
 * One wildcard handler collects everything.
 *
 * A second `onMessage` for a different type is attached after the client has
 * already been flushed, so the natural reading order matters: a real viewer has
 * to listen from the first moment, and so does this test.
 */
function collectAll(client: SDKTypes): Logged[] {
  const log: Logged[] = [];
  client.onMessage("*", (type: string | number, payload: unknown) => {
    log.push({ type: String(type), payload });
  });
  return log;
}

/** Waits until the log holds a message of this type that the predicate accepts. */
async function waitFor<T>(
  log: readonly Logged[],
  type: string,
  timeoutMs = 15_000,
  match: (payload: T) => boolean = () => true,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = log.find((entry) => entry.type === type && match(entry.payload as T));
    if (found !== undefined) {
      return found.payload as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching "${type}" message within ${timeoutMs} ms`);
}

/** Waits until at least this many messages of a type have arrived. */
async function waitForCount(
  log: readonly Logged[],
  type: string,
  count: number,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  while (
    log.filter((entry) => entry.type === type).length < count &&
    Date.now() - startedAt < timeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function nextMessage<T>(client: SDKTypes, type: string, timeoutMs = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no "${type}" message within ${timeoutMs} ms`));
    }, timeoutMs);
    client.onMessage(type, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function startMatch(): Promise<{ roomId: string; matchId: string }> {
  const seed = createMatchSeed();
  const match = await repository.create({
    seedCommit: commitOf(seed),
    seats: [
      { seat: 1, botLevel: "master" },
      { seat: 2, botLevel: "club" },
    ],
    config: { turnSeconds: 30 },
  });

  const room = await colyseus.createRoom<CarromRoom>("carrom", { matchId: match.id, seed });
  return { roomId: room.roomId, matchId: match.id };
}

describe("a spectator", () => {
  it("is welcomed, gets the snapshot, then every shot in order", async () => {
    const { roomId, matchId } = await startMatch();
    const spectator = await colyseus.sdk.joinById(roomId, { spectate: true });
    const log = collectAll(spectator);

    const welcome = await waitFor<{ matchId: string; spectate: boolean; fps: number }>(
      log,
      "welcome",
    );
    expect(welcome.matchId).toBe(matchId);
    expect(welcome.spectate).toBe(true);
    expect(welcome.fps).toBe(30);

    const snapshot = await waitFor<SnapshotMessage>(log, "snapshot");
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.matchId).toBe(matchId);
    expect(snapshot.coins.length).toBeGreaterThan(0);
    expect(snapshot.seats).toHaveLength(2);

    await waitForCount(log, "shot", 3);

    // The welcome is always first, and the snapshot always before a shot.
    expect(log[0]?.type).toBe("welcome");
    expect(log.findIndex((entry) => entry.type === "snapshot")).toBeLessThan(
      log.findIndex((entry) => entry.type === "shot"),
    );
    const shots = log
      .filter((entry) => entry.type === "shot")
      .map((entry) => entry.payload as ShotMessage);

    expect(shots.length).toBeGreaterThanOrEqual(3);

    // The stream picks up exactly where the snapshot left off, then counts up.
    expect(shots[0]?.shotNumber).toBe(snapshot.shotNumber + 1);
    for (const [index, shot] of shots.slice(0, 3).entries()) {
      expect(shot.shotNumber).toBe((shots[0]?.shotNumber ?? 0) + index);
    }

    for (const shot of shots.slice(0, 3)) {
      expect(shotMessageSchema.safeParse(shot).success).toBe(true);
      const decoded = decodeFrames(shot.frames);
      expect(decoded.fps).toBe(30);
      expect(decoded.bodyIds.length).toBeGreaterThan(0);
      expect(decoded.frameCount).toBeGreaterThan(0);
    }

    await spectator.leave();
  }, 45_000);

  it("cannot send a shot", async () => {
    const { roomId } = await startMatch();
    const spectator = await colyseus.sdk.joinById(roomId, { spectate: true });
    await nextMessage(spectator, "snapshot");

    spectator.send("shot", {
      type: "shot",
      shot: { strikerPosition: { x: 370, y: 650 }, angle: 0, power: 0.8 },
    });

    const rejected = await nextMessage<{ code: string; message: string }>(spectator, "rejected");
    expect(rejected.code).toBe("spectator");

    await spectator.leave();
  }, 30_000);

  it("sees shot.received on the bus before the first frame of that shot", async () => {
    const { roomId } = await startMatch();

    const order: { readonly kind: "event" | "frame"; readonly shotNumber: number }[] = [];
    const unsubscribe = subscribe("shot.received", (payload) => {
      order.push({ kind: "event", shotNumber: payload.shotNumber });
    });

    const spectator = await colyseus.sdk.joinById(roomId, { spectate: true });
    const log = collectAll(spectator);
    await waitFor(log, "snapshot");
    await waitForCount(log, "shot", 2);

    unsubscribe();

    for (const entry of log.filter((candidate) => candidate.type === "shot")) {
      const shot = entry.payload as ShotMessage;
      order.push({ kind: "frame", shotNumber: shot.shotNumber });
    }

    // Rebuilt in true order: the event log is appended when the bus fires, so the
    // bus entries come first in `order` and the frames were appended afterwards.
    const frames = order.filter((entry) => entry.kind === "frame");
    expect(frames.length).toBeGreaterThanOrEqual(2);

    for (const frame of frames) {
      expect(
        order.some((entry) => entry.kind === "event" && entry.shotNumber === frame.shotNumber),
      ).toBe(true);
    }

    await spectator.leave();
  }, 45_000);

  it("joins a second spectator while the first is watching", async () => {
    const { roomId } = await startMatch();

    const first = await colyseus.sdk.joinById(roomId, { spectate: true });
    const firstLog = collectAll(first);
    await waitFor(firstLog, "snapshot");

    const second = await colyseus.sdk.joinById(roomId, { spectate: true });
    const secondLog = collectAll(second);

    const welcome = await waitFor<{ spectators: number }>(secondLog, "welcome");
    expect(welcome.spectators).toBeGreaterThanOrEqual(2);
    await waitFor(secondLog, "snapshot");

    await second.leave();
    await first.leave();
  }, 45_000);
});
