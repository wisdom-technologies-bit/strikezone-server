import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/engines/carrom/config.js";
import { createInitialState, getLegalStrikerRange } from "../../src/engines/carrom/index.js";
import { commitOf, createMatchSeed } from "../../src/lib/fair-rng.js";
import type { MatchLogEntry } from "../../src/lib/match-log.js";
import {
  InMemoryMatchRepository,
  type MatchRecord,
  type MatchRepository,
} from "../../src/lib/match-repository.js";
import { verifyMatch } from "../../src/lib/match-verify.js";
import {
  CarromMatchRunner,
  runnerSeatsFromMatch,
  type CarromRunnerOptions,
} from "../../src/rooms/carrom-match-runner.js";

const config = resolveConfig();

interface MatchFixture {
  readonly repository: InMemoryMatchRepository;
  readonly runner: CarromMatchRunner;
  readonly match: MatchRecord;
  readonly seed: string;
}

async function startMatch(
  seats: Parameters<InMemoryMatchRepository["create"]>[0]["seats"],
  options: Partial<CarromRunnerOptions> = {},
): Promise<MatchFixture> {
  const repository = new InMemoryMatchRepository();
  const seed = createMatchSeed();
  const seedCommit = commitOf(seed);

  const match = await repository.create({
    seedCommit,
    config: { carrom: config },
    seats,
  });

  const runner = new CarromMatchRunner({
    matchId: match.id,
    seed,
    seedCommit,
    seats: runnerSeatsFromMatch(match),
    repository,
    config,
    botDelayMs: { min: 0, max: 0 },
    ...options,
  });

  return { repository, runner, match, seed };
}

describe("a full match between two bots", () => {
  it("plays to the end in under a minute and then verifies", async () => {
    const { repository, runner, match, seed } = await startMatch([
      { seat: 1, botLevel: "master" },
      { seat: 2, botLevel: "club" },
    ]);

    const started = Date.now();
    await runner.start();
    const result = await runner.finished;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(60_000);
    expect(result.reason).toBe("scored");
    expect(result.shots).toBeGreaterThan(20);
    expect(result.boards).toBeGreaterThanOrEqual(1);

    const report = await verifyMatch(match.id, repository);
    if (!report.ok) {
      console.log("verification failure:", report.failure, report.checks);
    }
    expect(report.ok).toBe(true);
    expect(report.shots).toBe(result.shots);

    const stored = await repository.get(match.id);
    expect(stored?.status).toBe("finished");
    expect(stored?.seedReveal).toBe(seed);
    expect(stored?.logHeadHash).toBe(runner.logHead);
    expect(stored?.resultSignature).toMatch(/^[0-9a-f]{64}$/);

    console.log(
      `bot match: ${result.shots} shots over ${result.boards} boards in ${elapsed} ms, ` +
        `winner seat ${String(result.winnerSeat)} (${result.scores.white}-${result.scores.black})`,
    );
  });

  it("logs every shot and every event, chained from the seed commitment", async () => {
    const { repository, runner, match } = await startMatch([
      { seat: 1, botLevel: "club" },
      { seat: 2, botLevel: "club" },
    ]);
    await runner.start();
    const result = await runner.finished;

    const events = await repository.listEvents(match.id);
    const shots = events.filter((entry) => entry.type === "shot");

    expect(events[0]?.type).toBe("match_start");
    expect(events[events.length - 1]?.type).toBe("match_end");
    expect(shots).toHaveLength(result.shots);
    expect(events[0]?.prevHash).toBe(match.seedCommit);
    expect(events.map((entry) => entry.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.some((entry) => entry.type === "coin_pocketed")).toBe(true);
  });
});

describe("the referee's guards", () => {
  it("refuses a shot from the seat that is not on turn", async () => {
    const { runner } = await startMatch([
      { seat: 1, playerId: "player-white" },
      { seat: 2, playerId: "player-black" },
    ]);
    await runner.start();

    const range = getLegalStrikerRange(createInitialState(config, "unused"), config);
    const outcome = await runner.submitShot(2, {
      strikerPosition: { x: 0, y: range.y },
      angle: Math.PI / 2,
      power: 0.5,
    });

    expect(outcome).toEqual({
      ok: false,
      code: "not_your_turn",
      message: "it is not your turn",
    });
  });

  it("refuses an illegal power and an illegal striker position", async () => {
    const { runner } = await startMatch([
      { seat: 1, playerId: "player-white" },
      { seat: 2, playerId: "player-black" },
    ]);
    await runner.start();

    const range = getLegalStrikerRange(createInitialState(config, "x"), config);

    const tooHard = await runner.submitShot(1, {
      strikerPosition: { x: 0, y: range.y },
      angle: 1,
      power: 1.5,
    });
    expect(tooHard.ok).toBe(false);
    expect(tooHard.ok === false && tooHard.code).toBe("illegal_shot");

    const offTheBaseline = await runner.submitShot(1, {
      strikerPosition: { x: range.maxX + 40, y: range.y },
      angle: 1,
      power: 0.5,
    });
    expect(offTheBaseline.ok).toBe(false);
    expect(offTheBaseline.ok === false && offTheBaseline.code).toBe("illegal_shot");
  });

  it("refuses a second shot for the same move, and a shot after the turn passed", async () => {
    const { runner } = await startMatch([
      { seat: 1, playerId: "player-white" },
      { seat: 2, playerId: "player-black" },
    ]);
    await runner.start();

    const first = await runner.submitShot(1, {
      strikerPosition: { x: 0, y: getLegalStrikerRange(createInitialState(config, "y"), config).y },
      angle: Math.PI / 2,
      power: 0,
    });
    expect(first.ok).toBe(true);

    // Same move number again: refused before the engine is even asked.
    const replay = await runner.submitShot(
      1,
      {
        strikerPosition: {
          x: 0,
          y: getLegalStrikerRange(createInitialState(config, "y"), config).y,
        },
        angle: Math.PI / 2,
        power: 0,
      },
      { expectedShot: 0 },
    );
    expect(replay.ok).toBe(false);
    expect(replay.ok === false && replay.code).toBe("stale_shot");

    // And the turn has passed, so a fresh shot message is refused too.
    const extra = await runner.submitShot(1, {
      strikerPosition: { x: 0, y: getLegalStrikerRange(createInitialState(config, "y"), config).y },
      angle: Math.PI / 2,
      power: 0,
    });
    expect(extra.ok).toBe(false);
    expect(extra.ok === false && extra.code).toBe("not_your_turn");
  });

  it("forfeits a seat that lets the clock run out three times", async () => {
    const { runner, repository, match } = await startMatch(
      [
        { seat: 1, playerId: "player-white" },
        { seat: 2, playerId: "player-black" },
      ],
      { turnSeconds: 0.02 },
    );
    await runner.start();
    const result = await runner.finished;

    expect(result.reason).toBe("forfeit");
    expect(result.winnerSeat).toBe(2);

    const events = await repository.listEvents(match.id);
    // Timeouts are counted per seat, and both seats time out before one reaches
    // three: the forfeiting seat has exactly three.
    const timeouts = events.filter((entry) => entry.type === "turn_timeout");
    const perSeat = new Map<number, number>();
    for (const entry of timeouts) {
      const seat = entry.payload["seat"] === 2 ? 2 : 1;
      perSeat.set(seat, (perSeat.get(seat) ?? 0) + 1);
    }
    expect([...perSeat.values()].some((count) => count === 3)).toBe(true);
    expect(timeouts.length).toBeGreaterThanOrEqual(3);
    expect(events.some((entry) => entry.type === "player_forfeit")).toBe(true);

    expect((await verifyMatch(match.id, repository)).ok).toBe(true);
  });

  it("forfeits a seat that leaves", async () => {
    const { runner } = await startMatch([
      { seat: 1, botLevel: "rookie" },
      { seat: 2, playerId: "player-black" },
    ]);
    await runner.start();

    await runner.forfeit(2, "disconnect");
    const result = await runner.finished;

    expect(result.reason).toBe("forfeit");
    expect(result.winnerSeat).toBe(1);
  });
});

describe("verification catches a tampered match", () => {
  /** Delegates to the in-memory store, then rewrites what comes back. */
  class TamperingRepository implements MatchRepository {
    constructor(
      private readonly inner: InMemoryMatchRepository,
      private readonly tamper: {
        events?: (events: MatchLogEntry[]) => MatchLogEntry[];
        match?: (match: MatchRecord) => MatchRecord;
      },
    ) {}

    create: MatchRepository["create"] = (input) => this.inner.create(input);
    markLive: MatchRepository["markLive"] = (id, input) => this.inner.markLive(id, input);
    appendEvents: MatchRepository["appendEvents"] = (id, entries) =>
      this.inner.appendEvents(id, entries);
    finish: MatchRepository["finish"] = (id, input) => this.inner.finish(id, input);

    async get(matchId: string): Promise<MatchRecord | null> {
      const match = await this.inner.get(matchId);
      return match === null || this.tamper.match === undefined ? match : this.tamper.match(match);
    }

    async listEvents(matchId: string): Promise<MatchLogEntry[]> {
      const events = await this.inner.listEvents(matchId);
      return this.tamper.events === undefined ? events : this.tamper.events(events);
    }
  }

  async function finishedMatch(): Promise<MatchFixture> {
    const fixture = await startMatch([
      { seat: 1, botLevel: "club" },
      { seat: 2, botLevel: "rookie" },
    ]);
    await fixture.runner.start();
    await fixture.runner.finished;
    return fixture;
  }

  it("rejects an edited event payload", async () => {
    const { repository, match } = await finishedMatch();
    const tampered = new TamperingRepository(repository, {
      events: (events) =>
        events.map((entry) =>
          entry.type === "shot" ? { ...entry, payload: { ...entry.payload, power: 0.123 } } : entry,
        ),
    });

    const report = await verifyMatch(match.id, tampered);
    expect(report.ok).toBe(false);
    expect(report.failure).toContain("hash does not match");
    expect(report.checks.some((check) => check.name === "hash_chain" && !check.ok)).toBe(true);
  });

  it("rejects a dropped event", async () => {
    const { repository, match } = await finishedMatch();
    const tampered = new TamperingRepository(repository, {
      events: (events) =>
        events
          .filter((entry) => entry.seq !== 5)
          .map((entry, index) => ({ ...entry, seq: index + 1 })),
    });

    const report = await verifyMatch(match.id, tampered);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.name === "hash_chain" && !check.ok)).toBe(true);
  });

  it("rejects a result that does not match the replayed board", async () => {
    const { repository, match } = await finishedMatch();
    const tampered = new TamperingRepository(repository, {
      match: (record) => ({
        ...record,
        result:
          record.result === null
            ? null
            : {
                ...record.result,
                scores: {
                  white: record.result.scores.white + 5,
                  black: record.result.scores.black,
                },
              },
      }),
    });

    const report = await verifyMatch(match.id, tampered);
    expect(report.ok).toBe(false);
    expect(report.failure).toContain("the replay ends");
  });

  it("refuses to verify a match that has not finished", async () => {
    const { repository, match, runner } = await startMatch([
      { seat: 1, botLevel: "rookie" },
      { seat: 2, botLevel: "rookie" },
    ]);
    await runner.start();
    runner.dispose();

    const report = await verifyMatch(match.id, repository);
    expect(report.ok).toBe(false);
    expect(report.failure).toContain("nothing to verify");
  });
});
