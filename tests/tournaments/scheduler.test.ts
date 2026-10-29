import { beforeEach, describe, expect, it } from "vitest";
import { commitOf } from "../../src/lib/fair-rng.js";
import { clearSubscribers } from "../../src/lib/events.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { InMemoryLedger } from "../../src/wallet/ledger.js";
import type { LaunchInput } from "../../src/tournaments/launcher.js";
import { InMemoryTournamentRepository } from "../../src/tournaments/repository.js";
import {
  InMemorySchedulerLease,
  TournamentScheduler,
  type SchedulerLease,
} from "../../src/tournaments/scheduler.js";
import { TournamentService } from "../../src/tournaments/service.js";
import type { TournamentConfig } from "../../src/tournaments/types.js";

/** The job runner: one instance at a time, and safe even when the lease fails. */

function config(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    game: "carrom",
    format: "single_elimination",
    minPlayers: 4,
    maxPlayers: 4,
    entryFeeMinor: 1_000,
    rakeBps: 1_000,
    prizeSplit: [60, 30, 10],
    botPrizePolicy: "next_human",
    fillWithBots: true,
    botLevel: "club",
    registrationOpensAt: "2026-10-29T09:00:00.000Z",
    registrationClosesAt: "2026-10-29T09:55:00.000Z",
    startsAt: "2026-10-29T10:00:00.000Z",
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
  const launched: LaunchInput[] = [];

  const service = new TournamentService({
    repository,
    matches,
    ledger,
    launcher: {
      async launch(input: LaunchInput) {
        launched.push(input);
        const match = await matches.get(input.matchId);
        const at = new Date().toISOString();
        await matches.markLive(input.matchId, {
          seedCommit: match?.seedCommit ?? commitOf(input.seed),
          startedAt: at,
        });
        await matches.recordJoin(input.matchId, 1, at);
        await matches.recordJoin(input.matchId, 2, at);
        await matches.finish(input.matchId, {
          seedReveal: input.seed,
          result: {
            winnerSeat: 1,
            winnerColour: "white",
            scores: { white: 25, black: 8 },
            boards: 1,
            shots: 30,
            reason: "scored",
            seedDraws: 10,
          },
          resultSignature: "signature",
          logHeadHash: "head",
          endedAt: at,
        });
        return { roomId: `room_${input.matchId}` };
      },
    },
    now: () => clock.value,
    newSeed: () => "0123456789abcdef0123456789abcdef",
  });

  const clock = { value: new Date("2026-10-29T09:30:00.000Z") };

  const scheduler = (lease: SchedulerLease, offsetMs = 0): TournamentScheduler =>
    new TournamentScheduler({
      repository,
      service,
      lease,
      now: () => new Date(clock.value.getTime() + offsetMs),
      intervalMs: 1_000,
    });

  return { repository, matches, ledger, service, launched, clock, scheduler };
}

describe("the tournament scheduler", () => {
  beforeEach(() => {
    clearSubscribers();
  });

  it("opens a draft whose registration time has come, and starts it on time", async () => {
    const h = build();
    const created = await h.repository.create({
      name: "Cup",
      game: "carrom",
      config: config(),
      currency: "XTS",
      status: "draft",
    });

    const first = await h.scheduler(new InMemorySchedulerLease()).tick();
    expect(first.opened).toBe(1);
    expect((await h.repository.get(created.id))?.status).toBe("registration");

    // Well before the start time: nothing to start.
    const second = await h.scheduler(new InMemorySchedulerLease()).tick();
    expect(second.started).toBe(0);

    h.clock.value = new Date("2026-10-29T10:00:01.000Z");
    const third = await h.scheduler(new InMemorySchedulerLease()).tick();
    expect(third.started).toBe(1);

    const started = await h.repository.get(created.id);
    expect(started?.status).toBe("running");
    // Four seats, filled with bots, and the whole bracket drawn.
    expect(await h.repository.listPositions(created.id)).toHaveLength(3);
  });

  it("runs one tick at a time", async () => {
    const h = build();
    await h.repository.create({
      name: "Cup",
      game: "carrom",
      config: config(),
      currency: "XTS",
      status: "registration",
    });

    const lease = new InMemorySchedulerLease();
    const [left, right] = await Promise.all([h.scheduler(lease).tick(), h.scheduler(lease).tick()]);

    // One of them worked and the other stood down.
    expect([left.skipped, right.skipped].filter((skipped) => skipped)).toHaveLength(1);
  });

  it("cannot launch the same match twice even if the lease fails", async () => {
    const h = build();
    // A lease that always agrees: the worst case, both instances think they lead.
    const brokenLease: SchedulerLease = {
      async acquire() {
        return true;
      },
      async release() {
        return undefined;
      },
    };

    const created = await h.repository.create({
      name: "Cup",
      game: "carrom",
      config: config(),
      currency: "XTS",
      status: "registration",
    });

    h.clock.value = new Date("2026-10-29T10:00:01.000Z");

    await Promise.all([h.scheduler(brokenLease).tick(), h.scheduler(brokenLease).tick()]);
    await Promise.all([h.scheduler(brokenLease).tick(), h.scheduler(brokenLease).tick()]);

    const tournament = await h.repository.get(created.id);
    expect(tournament?.status).not.toBe("cancelled");

    // Four entrants: two semi-finals and one final, each launched exactly once.
    const positions = await h.repository.listPositions(created.id);
    const matchIds = positions
      .map((position) => position.matchId)
      .filter((matchId) => matchId !== null);
    expect(new Set(matchIds).size).toBe(matchIds.length);
    expect(matchIds).toHaveLength(3);
    expect(h.launched).toHaveLength(3);
  });

  it("resumes a running tournament on a fresh instance", async () => {
    const h = build();
    const created = await h.repository.create({
      name: "Cup",
      game: "carrom",
      config: config(),
      currency: "XTS",
      status: "registration",
    });

    h.clock.value = new Date("2026-10-29T10:00:01.000Z");
    await h.scheduler(new InMemorySchedulerLease()).tick();
    expect((await h.repository.get(created.id))?.status).toBe("running");

    // A second instance, sharing nothing but the database, finishes it.
    const report = await h.scheduler(new InMemorySchedulerLease()).resume();
    expect(report.skipped).toBe(false);

    h.clock.value = new Date("2026-10-29T10:00:11.000Z");
    await h.scheduler(new InMemorySchedulerLease()).tick();

    expect((await h.repository.get(created.id))?.status).toBe("finished");
  });

  it("does not open a draft whose registration has not opened yet", async () => {
    const h = build();
    await h.repository.create({
      name: "Cup",
      game: "carrom",
      config: config({ registrationOpensAt: "2026-10-29T11:00:00.000Z" }),
      currency: "XTS",
      status: "draft",
    });

    const report = await h.scheduler(new InMemorySchedulerLease()).tick();
    expect(report.opened).toBe(0);
  });
});
