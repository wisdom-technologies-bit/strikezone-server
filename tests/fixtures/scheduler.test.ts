import { describe, expect, it } from "vitest";
import {
  InMemoryMatchRepository,
  type CreateMatchInput,
  type MatchRecord,
} from "../../src/lib/match-repository.js";
import { InMemoryMarketsRepository } from "../../src/odds/markets-store.js";
import { commitOf, verifyCommit } from "../../src/lib/fair-rng.js";
import {
  HouseFixturesScheduler,
  InMemoryFixtureLease,
  type FixtureLease,
} from "../../src/fixtures/scheduler.js";
import type { FixturesRepository } from "../../src/fixtures/repository.js";
import type { FixtureGame, FixturesConfig, StoredFixture } from "../../src/fixtures/types.js";
import type { FixturePriceReport } from "../../src/fixtures/pricing.js";

/**
 * The scheduler, against a clock a test controls.
 *
 * Everything the scheduler touches is real except the clock and the price: the
 * match store is the in-memory implementation the rooms use, the markets are the
 * same repository the pricer writes through, and the launcher is the seam the
 * tournament scheduler already had. Time is the only thing faked, because the
 * behaviour under test is what happens at a start time.
 */

const START = Date.parse("2026-10-31T08:00:00.000Z");
const MINUTE = 60_000;
const SECRET = "test-result-signing-secret-0123456789abcdef";

/** A match store that remembers the id and schedule of everything it created. */
class RecordingMatches extends InMemoryMatchRepository {
  readonly created: string[] = [];
  readonly schedules = new Map<string, string | null>();

  override async create(input: CreateMatchInput): Promise<MatchRecord> {
    const match = await super.create(input);
    this.created.push(match.id);
    this.schedules.set(match.id, input.scheduledAt ?? null);
    return match;
  }

  /** The rows, as the fixture repository would return them. */
  async rows(): Promise<readonly StoredFixture[]> {
    const matches = await Promise.all(this.created.map((id) => this.get(id)));
    return matches
      .filter((match): match is MatchRecord => match !== null)
      .map((match) => ({
        id: match.id,
        game: (match.game === "ludo" ? "ludo" : "carrom") as FixtureGame,
        status: match.status,
        scheduledAt: this.schedules.get(match.id) ?? null,
        seedCommit: match.seedCommit,
        startedAt: match.startedAt,
      }));
  }
}

/** The fixture repository, derived from the match store so the two cannot disagree. */
class DerivedFixturesRepository implements FixturesRepository {
  #paused = false;

  constructor(private readonly matches: RecordingMatches) {}

  async listUpcoming(limit: number): Promise<readonly StoredFixture[]> {
    const rows = await this.matches.rows();
    return rows
      .filter((row) => row.status === "scheduled")
      .sort((left, right) => (left.scheduledAt ?? "").localeCompare(right.scheduledAt ?? ""))
      .slice(0, limit);
  }

  async listRunning(): Promise<readonly StoredFixture[]> {
    return (await this.matches.rows()).filter((row) => row.status === "live");
  }

  async listRecentlyFinished(): Promise<readonly StoredFixture[]> {
    return (await this.matches.rows()).filter((row) => row.status === "finished");
  }

  isPaused(): Promise<boolean> {
    return Promise.resolve(this.#paused);
  }

  setPaused(paused: boolean): Promise<void> {
    this.#paused = paused;
    return Promise.resolve();
  }
}

interface Harness {
  readonly scheduler: HouseFixturesScheduler;
  readonly matches: RecordingMatches;
  readonly markets: InMemoryMarketsRepository;
  readonly fixtureRepository: DerivedFixturesRepository;
  readonly priced: string[];
  readonly launched: { matchId: string; seed: string; game: string }[];
  readonly events: { name: string; payload: unknown }[];
  advance(minutes: number): void;
}

function harness(
  overrides: Partial<FixturesConfig> = {},
  options: { readonly lease?: FixtureLease; readonly matches?: RecordingMatches } = {},
): Harness {
  let nowMs = START;
  const matches = options.matches ?? new RecordingMatches();
  const markets = new InMemoryMarketsRepository();
  const fixtureRepository = new DerivedFixturesRepository(matches);
  const priced: string[] = [];
  const launched: { matchId: string; seed: string; game: string }[] = [];
  const events: { name: string; payload: unknown }[] = [];

  const config: FixturesConfig = {
    enabled: true,
    target: 2,
    intervalMinutes: 5,
    betWindowSeconds: 120,
    maxConcurrent: 2,
    games: ["carrom", "ludo"],
    ...overrides,
  };

  const scheduler = new HouseFixturesScheduler({
    config,
    repository: fixtureRepository,
    matches,
    markets,
    launcher: {
      launch: async (input) => {
        launched.push({ matchId: input.matchId, seed: input.seed, game: input.game });
        await matches.markLive(input.matchId, {
          seedCommit: commitOf(input.seed),
          startedAt: new Date(nowMs).toISOString(),
        });
        return { roomId: `room-${input.matchId}` };
      },
    },
    lease: options.lease ?? new InMemoryFixtureLease(),
    secret: SECRET,
    price: (matchId: string, game: FixtureGame): Promise<FixturePriceReport> => {
      priced.push(matchId);
      return Promise.resolve({ matchId, game, simulations: 20_000, reduced: false, elapsedMs: 1 });
    },
    publish: (name, payload) => {
      events.push({ name, payload });
      return Promise.resolve();
    },
    now: () => new Date(nowMs),
  });

  return {
    scheduler,
    matches,
    markets,
    fixtureRepository,
    priced,
    launched,
    events,
    advance: (minutes: number) => {
      nowMs += minutes * MINUTE;
    },
  };
}

describe("the house fixture scheduler", () => {
  it("fills the set from cold, spacing the fixtures and pricing every one", async () => {
    const underTest = harness();
    const report = await underTest.scheduler.tick();

    expect(report.skipped).toBe(false);
    expect(report.created).toBe(2);
    expect(report.priced).toBe(2);
    expect(underTest.matches.created).toHaveLength(2);
    expect(underTest.priced).toHaveLength(2);

    const rows = await underTest.fixtureRepository.listUpcoming(10);
    expect(rows).toHaveLength(2);

    // The first fixture opens a window immediately; the second is one interval later.
    const first = Date.parse(rows[0]?.scheduledAt ?? "");
    const second = Date.parse(rows[1]?.scheduledAt ?? "");
    expect(first).toBe(START + 120_000);
    expect(second).toBe(first + 5 * MINUTE);
  });

  it("alternates the games, so the lobby gets both", async () => {
    const underTest = harness({ target: 4 });
    await underTest.scheduler.tick();

    const rows = await underTest.fixtureRepository.listUpcoming(10);
    expect(rows.map((row) => row.game)).toEqual(["carrom", "ludo", "carrom", "ludo"]);
  });

  it("starts a due fixture, closes the pre-match book and launches with its own seed", async () => {
    const underTest = harness({ target: 1 });
    await underTest.scheduler.tick();

    const [fixture] = await underTest.fixtureRepository.listUpcoming(1);
    if (fixture === undefined) {
      throw new Error("no fixture was created");
    }

    // A book as the pricer leaves it: the live-capable winner market open, and a
    // market that cannot be settled once the board moves still open.
    await underTest.markets.upsert([
      {
        matchId: fixture.id,
        marketType: "match_winner",
        subject: "",
        line: null,
        selectionKey: "white",
        status: "open",
        fairProbability: 0.55,
        oddsDecimal: 1.72,
        maxStakeMinor: 500_000,
        isLive: true,
      },
      {
        matchId: fixture.id,
        marketType: "points_handicap",
        subject: "points",
        line: -2,
        selectionKey: "white",
        status: "open",
        fairProbability: 0.5,
        oddsDecimal: 1.9,
        maxStakeMinor: 200_000,
        isLive: false,
      },
    ]);

    underTest.advance(3);
    const report = await underTest.scheduler.tick();

    expect(report.started).toBe(1);
    expect(underTest.launched).toHaveLength(1);

    const rows = await underTest.markets.listForMatch(fixture.id);
    const byType = new Map(rows.map((row) => [row.marketType, row.status]));
    expect(byType.get("match_winner")).toBe("open");
    expect(byType.get("points_handicap")).toBe("closed");

    const launched = underTest.launched[0];
    expect(launched?.matchId).toBe(fixture.id);
    // The seed is the fixture's own, and it opens the commitment on the row.
    expect(verifyCommit(launched?.seed ?? "", fixture.seedCommit ?? "")).toBe(true);

    // And the rest of the server is told the match is live.
    expect(underTest.events.map((event) => event.name)).toContain("match.live");
  });

  it("waits rather than starting more than the host can play", async () => {
    const underTest = harness({ target: 2, maxConcurrent: 1 });
    await underTest.scheduler.tick();
    // Both fixtures are now due.
    underTest.advance(10);

    const report = await underTest.scheduler.tick();
    expect(report.started).toBe(1);
    expect(report.delayed).toBe(1);

    // One is playing. The one that could not start keeps its place, so the set is
    // topped back up to two and no match ever runs beside it.
    const running = await underTest.fixtureRepository.listRunning();
    expect(running).toHaveLength(1);
    const rows = await underTest.fixtureRepository.listUpcoming(10);
    expect(rows).toHaveLength(2);
  });

  it("does the work once when two instances tick together", async () => {
    const shared = new InMemoryFixtureLease();
    const first = harness({ target: 3 }, { lease: shared });
    const second = harness({ target: 3 }, { lease: shared, matches: first.matches });

    const [reportA, reportB] = await Promise.all([first.scheduler.tick(), second.scheduler.tick()]);

    // One held the lease; the other did nothing at all.
    const skipped = [reportA, reportB].filter((report) => report.skipped);
    expect(skipped).toHaveLength(1);
    expect(first.matches.created).toHaveLength(3);
  });

  it("keeps scheduling after a restart, and starts what is already due", async () => {
    const first = harness({ target: 2 });
    await first.scheduler.tick();
    const before = await first.fixtureRepository.listUpcoming(10);
    expect(before).toHaveLength(2);

    // A new process: no memory, the same database, a fresh lease.
    const restarted = harness({ target: 2 }, { matches: first.matches });
    restarted.advance(3);

    const report = await restarted.scheduler.tick();
    expect(report.started).toBe(1);
    expect(report.created).toBe(1);
    // The fixture that was already scheduled was started, not created twice.
    expect(restarted.matches.created).toHaveLength(3);

    const launched = restarted.launched[0];
    const started = before[0];
    expect(launched?.matchId).toBe(started?.id);
    expect(verifyCommit(launched?.seed ?? "", started?.seedCommit ?? "")).toBe(true);
  });

  it("stops creating when paused, but never abandons a fixture people can bet on", async () => {
    const underTest = harness({ target: 2 });
    await underTest.scheduler.tick();
    await underTest.fixtureRepository.setPaused(true);
    underTest.advance(3);

    const report = await underTest.scheduler.tick();

    // The due fixture still starts, and nothing new is added: the matches it
    // creates are the two from before the pause.
    expect(report.started).toBe(1);
    expect(report.created).toBe(0);
    expect(underTest.matches.created).toHaveLength(2);
  });

  it("does nothing at all when it is switched off", async () => {
    const underTest = harness({ enabled: false });
    const report = await underTest.scheduler.tick();

    expect(report.skipped).toBe(true);
    expect(underTest.matches.created).toHaveLength(0);
  });
});
