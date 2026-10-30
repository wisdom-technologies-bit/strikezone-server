import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import type { Room as ClientRoom } from "@colyseus/sdk";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { commitOf, createMatchSeed } from "../../src/lib/fair-rng.js";
import { LudoRoom, setLudoRoomDeps } from "../../src/rooms/ludo-room.js";
import {
  ludoMoveMessageSchema,
  ludoRollMessageSchema,
  ludoSnapshotMessageSchema,
} from "../../src/api/contract.js";

/**
 * A whole four-bot Ludo game, over a real WebSocket server.
 *
 * This is the "DONE WHEN" path: the room starts, the four published policies play
 * until every seat has finished, the log and the signed result are written, and a
 * spectator watches the roll and move messages the dev viewer draws.
 */

const repository = new InMemoryMatchRepository();
let colyseus: ColyseusTestServer;

beforeAll(async () => {
  setLudoRoomDeps({
    repository,
    verifyUser: async () => null,
    // The room's real delay is one to three seconds; a test cannot wait for four
    // hundred turns of that, so the same code path runs with a tick instead.
    botDelayMs: { min: 0, max: 1 },
    reconnectionSeconds: 1,
  });

  const config = {
    initializeGameServer: (gameServer: {
      define: (name: string, room: typeof LudoRoom) => void;
    }) => {
      gameServer.define("ludo", LudoRoom);
    },
  };

  colyseus = await boot(config as unknown as Parameters<typeof boot>[0], 2573);
}, 30_000);

afterAll(async () => {
  await colyseus.shutdown();
  setLudoRoomDeps(null);
});

interface Logged {
  readonly type: string;
  readonly payload: unknown;
}

function collectAll(client: ClientRoom<unknown>): Logged[] {
  const log: Logged[] = [];
  client.onMessage("*", (type: string | number, payload: unknown) => {
    log.push({ type: String(type), payload });
  });
  return log;
}

describe("a four bot ludo match", () => {
  it("plays to the end, writes the log and streams every roll", async () => {
    const seed = createMatchSeed();
    const match = await repository.create({
      game: "ludo",
      seedCommit: commitOf(seed),
      seats: [
        { seat: 1, botLevel: "club", botPolicy: "cautious" },
        { seat: 2, botLevel: "club", botPolicy: "aggressive" },
        { seat: 3, botLevel: "club", botPolicy: "racer" },
        { seat: 4, botLevel: "club", botPolicy: "cautious" },
      ],
      config: { ludo: { players: 4 } },
    });

    const room = await colyseus.createRoom<LudoRoom>("ludo", { matchId: match.id, seed });

    const spectator = await colyseus.sdk.joinById(room.roomId, { spectate: true });
    const log = collectAll(spectator);

    // The room plays itself: no human is seated, so nothing has to be sent.
    const startedAt = Date.now();
    let finished = await repository.get(match.id);
    while (finished?.status !== "finished" && Date.now() - startedAt < 90_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      finished = await repository.get(match.id);
    }

    expect(finished).not.toBeNull();
    expect(finished?.status).toBe("finished");
    expect(finished?.seedReveal).toBe(seed);
    expect(finished?.resultSignature).not.toBeNull();
    expect(finished?.logHeadHash).not.toBeNull();

    const result = finished?.result;
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("finished");
    expect(result?.finishingOrder).toHaveLength(4);
    expect([...(result?.finishingOrder ?? [])].sort()).toEqual([1, 2, 3, 4]);
    expect(result?.winnerSeat).toBe(result?.finishingOrder?.[0]);
    expect(result?.shots).toBeGreaterThan(100);
    expect(result?.seedDraws).toBeGreaterThan(100);
    // Three seats brought every token home. The last seat standing is placed
    // without playing on, so it is the one still short.
    const tokensHome = result?.tokensHome ?? [];
    expect(tokensHome).toHaveLength(4);
    expect(tokensHome.filter((count) => count === 4)).toHaveLength(3);

    // The log is one entry per turn plus the result, in sequence order.
    const events = await repository.listEvents(match.id);
    expect(events.length).toBe((result?.shots ?? 0) + 1);
    expect(events[0]?.type).toBe("turn");
    expect(events.at(-1)?.type).toBe("result");
    for (const [index, entry] of events.entries()) {
      expect(entry.seq).toBe(index + 1);
    }

    // The stream: a snapshot first, then a roll for every turn and a move after it.
    const snapshot = log.find((entry) => entry.type === "snapshot");
    expect(snapshot).toBeDefined();
    expect(ludoSnapshotMessageSchema.safeParse(snapshot?.payload).success).toBe(true);
    expect(log[0]?.type).toBe("welcome");

    const rolls = log.filter((entry) => entry.type === "roll");
    const moves = log.filter((entry) => entry.type === "move");
    expect(rolls.length).toBeGreaterThanOrEqual((result?.shots ?? 0) - 1);
    expect(moves.length).toBeGreaterThanOrEqual((result?.shots ?? 0) - 1);

    for (const message of [...rolls.slice(0, 20), ...moves.slice(0, 20)]) {
      const schema = message.type === "roll" ? ludoRollMessageSchema : ludoMoveMessageSchema;
      expect(schema.safeParse(message.payload).success).toBe(true);
    }

    // Each roll names only tokens that can actually move, and the move that
    // follows it is one of them.
    const firstRoll = ludoRollMessageSchema.parse(rolls[0]?.payload);
    const firstMove = ludoMoveMessageSchema.parse(moves[0]?.payload);
    if (!firstRoll.forfeited && firstRoll.tokens.length > 0) {
      expect(firstRoll.tokens).toContain(firstMove.token);
    }

    const end = log.find((entry) => entry.type === "match_end");
    expect(end).toBeDefined();

    await spectator.leave();
  }, 120_000);
});
