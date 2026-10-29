import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { commitOf } from "../../src/lib/fair-rng.js";
import { MatchLogBuilder, signResult } from "../../src/lib/match-log.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { setMatchRepository } from "../../src/lib/match-store.js";

const repository = new InMemoryMatchRepository();

afterEach(() => {
  setMatchRepository(null);
});

async function liveMatch() {
  const seedCommit = commitOf("a-seed-that-is-not-revealed-yet");
  const match = await repository.create({
    seedCommit,
    seats: [
      { seat: 1, botLevel: "club" },
      { seat: 2, botLevel: "rookie" },
    ],
  });

  const log = new MatchLogBuilder(seedCommit);
  log.append("match_start", { matchId: match.id });
  const shot = log.append("shot", {
    shotNumber: 1,
    seat: 1,
    shot: { x: 0, y: -280, angle: 1.5, power: 0.5 },
  });
  log.append("coin_pocketed", { shot: 1, coinId: "w1", by: "white", creditedTo: "white" });

  await repository.markLive(match.id, { seedCommit, startedAt: new Date().toISOString() });
  await repository.appendEvents(match.id, [...log.entries]);

  return { match, log, seedCommit, shot };
}

describe("GET /api/matches/:id/replay", () => {
  it("serves the events and the commitment, without the seed, while the match is live", async () => {
    setMatchRepository(repository);
    const { match } = await liveMatch();

    const response = await request(createApp()).get(`/api/matches/${match.id}/replay`);

    expect(response.status).toBe(200);
    const body = response.body as {
      ok: boolean;
      match: { status: string; seedReveal: unknown; seedCommit: string; seats: unknown[] };
      events: Array<{ seq: number; type: string; hash: string }>;
      verification: { chainOk: boolean; head: string | null };
    };

    expect(body.ok).toBe(true);
    expect(body.match.status).toBe("live");
    expect(body.match.seedReveal).toBeNull();
    expect(body.match.seedCommit).toHaveLength(64);
    expect(body.match.seats).toHaveLength(2);
    expect(body.events.map((entry) => entry.type)).toEqual([
      "match_start",
      "shot",
      "coin_pocketed",
    ]);
    expect(body.verification.chainOk).toBe(true);
    // The head is the hash of the last event, which is what commits to the chain.
    const last = body.events[body.events.length - 1];
    expect(body.verification.head).toBe(last?.hash);
  });

  it("reveals the seed once the match has finished", async () => {
    setMatchRepository(repository);
    const { match, log, seedCommit } = await liveMatch();
    const seedReveal = "a-seed-that-is-not-revealed-yet";

    const result = {
      winnerSeat: 1 as const,
      winnerColour: "white" as const,
      scores: { white: 25, black: 12 },
      boards: 6,
      shots: 1,
      reason: "scored" as const,
      seedDraws: 3,
    };
    const closing = log.append("match_end", { ...result });
    await repository.appendEvents(match.id, [closing]);
    const logHeadHash = log.head;
    await repository.finish(match.id, {
      seedReveal,
      result,
      resultSignature: signResult(result, logHeadHash),
      logHeadHash,
      endedAt: new Date().toISOString(),
    });

    const response = await request(createApp()).get(`/api/matches/${match.id}/replay`);
    const body = response.body as {
      match: { status: string; seedReveal: string; result: { scores: { white: number } } };
    };

    expect(response.status).toBe(200);
    expect(body.match.status).toBe("finished");
    expect(body.match.seedReveal).toBe(seedReveal);
    expect(body.match.result.scores.white).toBe(25);
    expect(commitOf(seedReveal)).toBe(seedCommit);
  });

  it("404s for a match that does not exist", async () => {
    setMatchRepository(repository);
    const response = await request(createApp()).get("/api/matches/no-such-match/replay");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ ok: false, error: "not_found" });
  });
});
