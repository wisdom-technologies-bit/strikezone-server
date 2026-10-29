import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createDevRouter } from "../../src/api/dev.js";
import { verifyCommit } from "../../src/lib/fair-rng.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { setMatchRepository } from "../../src/lib/match-store.js";

const repository = new InMemoryMatchRepository();

afterEach(() => {
  setMatchRepository(null);
});

function devApp(created: Array<{ roomName: string; options: Record<string, unknown> }>) {
  const app = express();
  app.use(express.json());
  app.use(
    createDevRouter({
      createRoom: async (roomName, options) => {
        created.push({ roomName, options });
        return { roomId: "room-under-test" };
      },
    }),
  );
  return app;
}

describe("POST /dev/start-match", () => {
  it("creates a match with two bot seats, commits to a seed and opens a room", async () => {
    setMatchRepository(repository);
    const created: Array<{ roomName: string; options: Record<string, unknown> }> = [];

    const response = await request(devApp(created)).post("/dev/start-match").send({});

    expect(response.status).toBe(201);
    const body = response.body as {
      ok: boolean;
      matchId: string;
      roomId: string;
      seedCommit: string;
      seats: Array<{ isBot: boolean; botPolicy: string; displayName: string }>;
    };

    expect(body.ok).toBe(true);
    expect(body.roomId).toBe("room-under-test");
    expect(body.seedCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(body.seats).toHaveLength(2);
    expect(body.seats.every((seat) => seat.isBot)).toBe(true);
    expect(body.seats[0]?.displayName).toBe("Bot Master");
    expect(body.seats[1]?.botPolicy).toBe("carrom_club");

    // The room is handed the seed itself, and only that seed verifies against the
    // commitment the response publishes.
    expect(created).toHaveLength(1);
    const options = created[0]?.options ?? {};
    expect(created[0]?.roomName).toBe("carrom");
    expect(options["matchId"]).toBe(body.matchId);
    expect(verifyCommit(String(options["seed"]), body.seedCommit)).toBe(true);

    const stored = await repository.get(body.matchId);
    expect(stored?.status).toBe("scheduled");
    expect(stored?.seedCommit).toBe(body.seedCommit);
  });

  it("accepts explicit levels and a turn timer", async () => {
    setMatchRepository(repository);
    const created: Array<{ roomName: string; options: Record<string, unknown> }> = [];

    const response = await request(devApp(created))
      .post("/dev/start-match")
      .send({ white: { bot: "rookie" }, black: { bot: "master" }, turnSeconds: 45 });

    expect(response.status).toBe(201);
    const body = response.body as { seats: Array<{ botPolicy: string }> };
    expect(body.seats.map((seat) => seat.botPolicy)).toEqual(["carrom_rookie", "carrom_master"]);
    expect(created[0]?.options["turnSeconds"]).toBe(45);
  });

  it("rejects an unknown bot level and an unknown field", async () => {
    setMatchRepository(repository);
    const created: Array<{ roomName: string; options: Record<string, unknown> }> = [];
    const app = devApp(created);

    const badLevel = await request(app)
      .post("/dev/start-match")
      .send({ white: { bot: "legend" } });
    expect(badLevel.status).toBe(400);
    expect(badLevel.body).toMatchObject({ ok: false, error: "invalid_request" });

    const unknownField = await request(app).post("/dev/start-match").send({ stakeKobo: 500 });
    expect(unknownField.status).toBe(400);

    expect(created).toHaveLength(0);
  });

  it("is not mounted outside development", async () => {
    // The suite runs with NODE_ENV=test, so the real app has no such route at all.
    const { createApp } = await import("../../src/app.js");
    const response = await request(createApp()).post("/dev/start-match").send({});

    expect(response.status).toBe(404);
  });
});
