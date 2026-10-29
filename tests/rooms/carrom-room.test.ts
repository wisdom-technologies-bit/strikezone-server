import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import type { Room as SDKTypes } from "@colyseus/sdk";
import { commitOf, createMatchSeed } from "../../src/lib/fair-rng.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { verifyMatch } from "../../src/lib/match-verify.js";
import { CarromRoom, setCarromRoomDeps } from "../../src/rooms/carrom-room.js";

/**
 * The room, over a real WebSocket server.
 *
 * These tests boot an actual Colyseus server and join it with real clients, so
 * what is exercised is the whole path a browser takes: auth, message validation,
 * the spectator guard, broadcasts and state sync. Only two things are substituted:
 * the match store (in memory) and the token check (a stub, since there is no
 * Supabase project in a test).
 */

const TOKEN_A = "test-token-user-a-0123456789";
const TOKEN_B = "test-token-user-b-0123456789";
const TOKEN_OUTSIDER = "test-token-outside-0123456789";

const TOKENS: Record<string, string> = { [TOKEN_A]: "user-a", [TOKEN_B]: "user-b" };
const repository = new InMemoryMatchRepository();

let colyseus: ColyseusTestServer;

function useRoomDeps(botDelayMs: { min: number; max: number }): void {
  setCarromRoomDeps({
    repository,
    verifyUser: async (token: string) => TOKENS[token] ?? null,
    botDelayMs,
    // A one-second reconnection window keeps the suite quick; production uses 60.
    reconnectionSeconds: 1,
  });
}

beforeAll(async () => {
  useRoomDeps({ min: 0, max: 0 });
  const config = {
    initializeGameServer: (gameServer: {
      define: (name: string, room: typeof CarromRoom) => void;
    }) => {
      gameServer.define("carrom", CarromRoom);
    },
  };

  colyseus = await boot(config as unknown as Parameters<typeof boot>[0]);
}, 30_000);

afterAll(async () => {
  await colyseus.shutdown();
  setCarromRoomDeps(null);
});

afterEach(() => {
  useRoomDeps({ min: 0, max: 0 });
});

async function newMatch(seats: Parameters<InMemoryMatchRepository["create"]>[0]["seats"]) {
  const seed = createMatchSeed();
  const seedCommit = commitOf(seed);
  const match = await repository.create({ seedCommit, seats, config: { turnSeconds: 30 } });
  return { seed, seedCommit, match };
}

/** Waits for one message of a type, or fails the test after a timeout. */
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

describe("a live room", () => {
  it("plays a bot match to the end, broadcasts shots, and verifies", async () => {
    useRoomDeps({ min: 2, max: 6 });
    const { seed, seedCommit, match } = await newMatch([
      { seat: 1, botLevel: "master" },
      { seat: 2, botLevel: "club" },
    ]);

    const room = await colyseus.createRoom<CarromRoom>("carrom", {
      matchId: match.id,
      seed,
      turnSeconds: 30,
    });

    const spectator = await colyseus.sdk.joinById(room.roomId, { spectate: true });
    const shots: Array<{ shotNumber: number; seat: number; events: Array<{ type: string }> }> = [];
    spectator.onMessage(
      "shot",
      (payload: { shotNumber: number; seat: number; events: Array<{ type: string }> }) => {
        shots.push(payload);
      },
    );

    const ended = await nextMessage<{ winnerSeat: number | null; scores: { white: number } }>(
      spectator,
      "match_end",
      20_000,
    );

    expect(ended).toHaveProperty("scores");
    expect(shots.length).toBeGreaterThan(10);
    expect(shots.some((shot) => shot.events.length > 0)).toBe(true);

    // Both seats are published as bots: no client can mistake one for a person.
    const state = spectator.state as unknown as {
      seats: Map<string, { isBot: boolean; botPolicy: string; displayName: string }>;
      seedCommit: string;
    };
    const seats = [...state.seats.values()];
    expect(seats).toHaveLength(2);
    expect(seats.every((seat) => seat.isBot)).toBe(true);
    expect(seats.map((seat) => seat.botPolicy)).toEqual(["carrom_master", "carrom_club"]);
    expect(state.seedCommit).toBe(seedCommit);

    const report = await verifyMatch(match.id, repository);
    expect(report.ok).toBe(true);

    await spectator.leave();
    await room.disconnect();
  }, 40_000);

  it("refuses a shot from a spectator", async () => {
    const { seed, match } = await newMatch([
      { seat: 1, playerId: "user-a" },
      { seat: 2, playerId: "user-b" },
    ]);

    const room = await colyseus.createRoom<CarromRoom>("carrom", {
      matchId: match.id,
      seed,
      turnSeconds: 30,
    });
    const spectator = await colyseus.sdk.joinById(room.roomId, { spectate: true });

    const rejected = nextMessage<{ code: string }>(spectator, "rejected");
    spectator.send("shot", {
      type: "shot",
      shot: { strikerPosition: { x: 0, y: -280 }, angle: 1.5, power: 0.5 },
    });

    await expect(rejected).resolves.toMatchObject({ code: "spectator" });
    await spectator.leave();
    await room.disconnect();
  }, 20_000);
});

describe("a seated player", () => {
  it("can shoot on their turn, and not out of turn", async () => {
    const { seed, match } = await newMatch([
      { seat: 1, playerId: "user-a" },
      { seat: 2, playerId: "user-b" },
    ]);

    const room = await colyseus.createRoom<CarromRoom>("carrom", {
      matchId: match.id,
      seed,
      turnSeconds: 30,
    });

    const white = await colyseus.sdk.joinById(room.roomId, { token: TOKEN_A });
    const black = await colyseus.sdk.joinById(room.roomId, { token: TOKEN_B });

    // Let the room settle after both joins before shooting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Black is not on turn: the referee says so, and nothing is applied.
    const outOfTurn = nextMessage<{ code: string }>(black, "rejected");
    black.send("shot", {
      type: "shot",
      shot: { strikerPosition: { x: 0, y: 280 }, angle: -1.5, power: 0.5 },
    });
    await expect(outOfTurn).resolves.toMatchObject({ code: "not_your_turn" });

    // White is, and the shot is broadcast.
    const broadcast = nextMessage<{ seat: number; shotNumber: number }>(black, "shot");
    white.send("shot", {
      type: "shot",
      shot: { strikerPosition: { x: 0, y: -280 }, angle: Math.PI / 2, power: 0.5 },
      expectedShot: 0,
    });
    const shot = await broadcast;
    expect(shot.seat).toBe(1);
    expect(shot.shotNumber).toBe(1);

    await white.leave();
    await black.leave();
    await room.disconnect();
  }, 20_000);

  it("is refused for an illegal power, a malformed message and a stale move", async () => {
    const { seed, match } = await newMatch([
      { seat: 1, playerId: "user-a" },
      { seat: 2, playerId: "user-b" },
    ]);

    const room = await colyseus.createRoom<CarromRoom>("carrom", {
      matchId: match.id,
      seed,
      turnSeconds: 30,
    });
    const white = await colyseus.sdk.joinById(room.roomId, { token: TOKEN_A });

    const tooHard = nextMessage<{ code: string }>(white, "rejected");
    white.send("shot", {
      type: "shot",
      shot: { strikerPosition: { x: 0, y: -280 }, angle: 1.5, power: 1.5 },
    });
    await expect(tooHard).resolves.toMatchObject({ code: "invalid_message" });

    const unknownField = nextMessage<{ code: string }>(white, "rejected");
    white.send("shot", { type: "shot", shot: { x: 1 }, cheat: true });
    await expect(unknownField).resolves.toMatchObject({ code: "invalid_message" });

    // A legal shot, then the same move number again: refused as stale.
    const accepted = nextMessage<{ shotNumber: number }>(white, "shot");
    white.send("shot", {
      type: "shot",
      shot: { strikerPosition: { x: 0, y: -280 }, angle: Math.PI / 2, power: 0 },
      expectedShot: 0,
    });
    await accepted;

    const stale = nextMessage<{ code: string }>(white, "rejected");
    white.send("shot", {
      type: "shot",
      shot: { strikerPosition: { x: 0, y: -280 }, angle: Math.PI / 2, power: 0 },
      expectedShot: 0,
    });
    await expect(stale).resolves.toMatchObject({ code: "stale_shot" });

    await white.leave();
    await room.disconnect();
  }, 20_000);

  it("cannot join a match they are not seated in, and refuses without taking the room down", async () => {
    const { seed, match } = await newMatch([
      { seat: 1, playerId: "user-a" },
      { seat: 2, playerId: "user-b" },
    ]);

    // Both tokens are valid: only one of the two users holds a seat here.
    setCarromRoomDeps({
      repository,
      verifyUser: async (token: string) => {
        if (token === TOKEN_A) {
          return "user-a";
        }
        if (token === TOKEN_OUTSIDER) {
          return "user-outsider";
        }
        return null;
      },
      botDelayMs: { min: 0, max: 0 },
      reconnectionSeconds: 1,
    });

    const room = await colyseus.createRoom<CarromRoom>("carrom", {
      matchId: match.id,
      seed,
      turnSeconds: 30,
    });

    // The seated player is in.
    const seated = await colyseus.sdk.joinById(room.roomId, { token: TOKEN_A });
    expect(seated.sessionId.length).toBeGreaterThan(0);

    // A valid token that is not seated here is refused, and the room carries on:
    // a failed join must never take the room down for the player who is in it.
    await expect(colyseus.sdk.joinById(room.roomId, { token: TOKEN_OUTSIDER })).rejects.toThrow(
      /not seated/i,
    );

    const state = seated.state as unknown as { status?: string; shotNumber?: number };
    expect(state.status).toBe("live");

    await seated.leave();
    await room.disconnect();
  }, 20_000);
});
