import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createAdminTournamentsRouter } from "../../src/api/admin-tournaments.js";
import { createTournamentsRouter } from "../../src/api/tournaments.js";
import { clearSubscribers } from "../../src/lib/events.js";
import { setLedger } from "../../src/wallet/ledger.js";
import { InMemoryLedger } from "../../src/wallet/ledger.js";
import { setMatchRepository } from "../../src/lib/match-store.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { setTournamentRepository } from "../../src/tournaments/repository.js";
import { InMemoryTournamentRepository } from "../../src/tournaments/repository.js";
import { TournamentService } from "../../src/tournaments/service.js";
import type { LaunchInput } from "../../src/tournaments/launcher.js";
import type { TournamentConfig } from "../../src/tournaments/types.js";

/** The API on its own, with the tournament stores swapped for in-memory ones. */

const ADMIN = "test-admin-api-key-0123456789";
const STARTED = "2026-10-29T10:00:00.000Z";

function config(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    game: "carrom",
    format: "single_elimination",
    minPlayers: 2,
    maxPlayers: 8,
    entryFeeMinor: 0,
    rakeBps: 1_000,
    prizeSplit: [60, 30, 10],
    botPrizePolicy: "next_human",
    fillWithBots: false,
    botLevel: "club",
    registrationOpensAt: "2026-10-29T09:00:00.000Z",
    registrationClosesAt: "2026-10-29T09:55:00.000Z",
    startsAt: STARTED,
    walkoverSeconds: 180,
    match: { targetPoints: 25, boardsPerMatch: 1, turnSeconds: 30 },
    allowSpectators: true,
    ...overrides,
  };
}

function build() {
  const repository = new InMemoryTournamentRepository();
  const matches = new InMemoryMatchRepository();
  const ledger = new InMemoryLedger("XTS");

  const service = new TournamentService({
    repository,
    matches,
    ledger,
    launcher: {
      async launch(input: LaunchInput) {
        return { roomId: `room_${input.matchId}` };
      },
    },
    now: () => new Date("2026-10-29T09:30:00.000Z"),
    newSeed: () => "0123456789abcdef0123456789abcdef",
  });

  const verifyUser = async (token: string): Promise<{ id: string; displayName: string } | null> =>
    token === "good-token" ? { id: "profile_h1", displayName: "Human 1" } : null;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(createTournamentsRouter({ service, repository, verifyUser }));
  app.use(createAdminTournamentsRouter({ service, repository }));
  app.use((_request, response) => {
    response.status(404).json({ ok: false, error: "not_found" });
  });

  return { app, repository, service };
}

describe("the tournament API", () => {
  beforeEach(() => {
    clearSubscribers();
    setTournamentRepository(null);
    setMatchRepository(null);
    setLedger(null);
  });

  it("refuses an admin request without the key, and with the wrong one", async () => {
    const { app } = build();

    const missing = await request(app).post("/api/admin/tournaments").send({ name: "Cup" });
    expect(missing.status).toBe(403);

    const wrong = await request(app)
      .post("/api/admin/tournaments")
      .set("x-admin-key", "not-the-key-but-long-enough-to-compare")
      .send({ name: "Cup" });

    expect(wrong.status).toBe(403);
  });

  it("creates a tournament and rejects unknown fields", async () => {
    const { app } = build();

    const created = await request(app)
      .post("/api/admin/tournaments")
      .set("x-admin-key", ADMIN)
      .send({ name: "Friday Cup", config: config() });

    expect(created.status).toBe(201);
    const body = created.body as { ok: boolean; tournament: { id: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.tournament.status).toBe("draft");

    const rejected = await request(app)
      .post("/api/admin/tournaments")
      .set("x-admin-key", ADMIN)
      .send({ name: "Friday Cup", config: config(), sneaky: true });

    expect(rejected.status).toBe(400);
  });

  it("rejects a config the format cannot run", async () => {
    const { app } = build();

    const response = await request(app)
      .post("/api/admin/tournaments")
      .set("x-admin-key", ADMIN)
      .send({ name: "Too Big", config: config({ format: "round_robin", maxPlayers: 9 }) });

    expect(response.status).toBe(400);
  });

  it("opens, lists and reads a tournament with its bracket", async () => {
    const { app, repository } = build();

    const created = await request(app)
      .post("/api/admin/tournaments")
      .set("x-admin-key", ADMIN)
      .send({ name: "Friday Cup", config: config() });
    const id = (created.body as { tournament: { id: string } }).tournament.id;

    const opened = await request(app)
      .post(`/api/admin/tournaments/${id}/open`)
      .set("x-admin-key", ADMIN)
      .send({});
    expect(opened.status).toBe(200);

    const listed = await request(app).get("/api/tournaments?status=registration");
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { tournaments: Array<{ id: string }> }).tournaments.map((t) => t.id),
    ).toContain(id);

    const detail = await request(app).get(`/api/tournaments/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ ok: true, tournament: { id } });

    const missing = await request(app).get("/api/tournaments/nope");
    expect(missing.status).toBe(404);

    void repository;
  });

  it("rejects an unknown query parameter instead of ignoring it", async () => {
    const { app } = build();

    const response = await request(app).get("/api/tournaments?sort=prize");
    expect(response.status).toBe(400);
  });

  it("requires a token to register, and refuses a bad one", async () => {
    const { app } = build();

    const created = await request(app)
      .post("/api/admin/tournaments")
      .set("x-admin-key", ADMIN)
      .send({ name: "Friday Cup", config: config() });
    const id = (created.body as { tournament: { id: string } }).tournament.id;
    await request(app).post(`/api/admin/tournaments/${id}/open`).set("x-admin-key", ADMIN).send({});

    const anonymous = await request(app).post(`/api/tournaments/${id}/register`).send({});
    expect(anonymous.status).toBe(401);

    const forged = await request(app)
      .post(`/api/tournaments/${id}/register`)
      .set("Authorization", "Bearer not-a-real-token")
      .send({});
    expect(forged.status).toBe(401);

    const joined = await request(app)
      .post(`/api/tournaments/${id}/register`)
      .set("Authorization", "Bearer good-token")
      .send({});
    expect(joined.status).toBe(201);

    const again = await request(app)
      .post(`/api/tournaments/${id}/register`)
      .set("Authorization", "Bearer good-token")
      .send({});
    expect(again.status).toBe(409);

    const withdrawn = await request(app)
      .post(`/api/tournaments/${id}/withdraw`)
      .set("Authorization", "Bearer good-token")
      .send({});
    expect(withdrawn.status).toBe(200);
  });

  it("cancels and reports what was refunded", async () => {
    const { app } = build();

    const created = await request(app)
      .post("/api/admin/tournaments")
      .set("x-admin-key", ADMIN)
      .send({ name: "Friday Cup", config: config() });
    const id = (created.body as { tournament: { id: string } }).tournament.id;
    await request(app).post(`/api/admin/tournaments/${id}/open`).set("x-admin-key", ADMIN).send({});

    const cancelled = await request(app)
      .post(`/api/admin/tournaments/${id}/cancel`)
      .set("x-admin-key", ADMIN)
      .send({ reason: "no officials available" });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ ok: true, refundedEntries: 0, refundedMinor: 0 });
  });
});
