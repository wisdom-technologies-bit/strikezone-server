import { afterEach, describe, expect, it } from "vitest";
import { InMemoryBetsRepository } from "../../src/betting/bets-store.js";
import { settleMatch } from "../../src/betting/settle.js";
import type { BetRow } from "../../src/betting/types.js";
import { commitOf, verifyCommit } from "../../src/lib/fair-rng.js";
import {
  InMemoryMatchRepository,
  type CreateMatchInput,
  type MatchRecord,
} from "../../src/lib/match-repository.js";
import { verifyMatch } from "../../src/lib/match-verify.js";
import { InMemoryMarketsRepository } from "../../src/odds/markets-store.js";
import { attachOddsEngine, type OddsEngine } from "../../src/odds/live.js";
import { priceLudoMatch } from "../../src/odds/ludo-pricer.js";
import { LudoMatchRunner, ludoRunnerSeatsFromMatch } from "../../src/rooms/ludo-match-runner.js";
import { subscribeSettlement } from "../../src/betting/settle.js";
import { InMemoryLedger } from "../../src/wallet/ledger.js";
import { HouseFixturesScheduler, InMemoryFixtureLease } from "../../src/fixtures/scheduler.js";
import { fixtureSeed } from "../../src/fixtures/seed.js";
import type { FixturesRepository } from "../../src/fixtures/repository.js";
import type { FixtureGame, FixturesConfig, StoredFixture } from "../../src/fixtures/types.js";
import { logger } from "../../src/lib/logger.js";

/**
 * One whole house fixture, from nothing to money.
 *
 * The match is played by the real Ludo runner against the in-memory match store,
 * priced by the real Ludo pricer into the in-memory markets table, verified by the
 * real verifier replaying its own log, and settled through the settlement
 * subscriber that runs in production. Only the storage and the clock are local.
 */

const START = Date.parse("2026-10-31T09:00:00.000Z");
const SECRET = "test-result-signing-secret-0123456789abcdef";

class RecordingMatches extends InMemoryMatchRepository {
  readonly created: string[] = [];
  readonly schedules = new Map<string, string | null>();

  override async create(input: CreateMatchInput): Promise<MatchRecord> {
    const match = await super.create(input);
    this.created.push(match.id);
    this.schedules.set(match.id, input.scheduledAt ?? null);
    return match;
  }

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

class DerivedFixturesRepository implements FixturesRepository {
  constructor(private readonly matches: RecordingMatches) {}

  async listUpcoming(): Promise<readonly StoredFixture[]> {
    return (await this.matches.rows()).filter((row) => row.status === "scheduled");
  }

  async listRunning(): Promise<readonly StoredFixture[]> {
    return (await this.matches.rows()).filter((row) => row.status === "live");
  }

  async listRecentlyFinished(): Promise<readonly StoredFixture[]> {
    return (await this.matches.rows()).filter((row) => row.status === "finished");
  }

  isPaused(): Promise<boolean> {
    return Promise.resolve(false);
  }

  setPaused(): Promise<void> {
    return Promise.resolve();
  }
}

/** Polls a condition, because the runner plays on real timers. */
async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the match did not finish in time");
}

describe("a house fixture, end to end", () => {
  let engine: OddsEngine | null = null;
  let unsubscribe: (() => void) | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    unsubscribe?.();
    unsubscribe = null;
  });

  it("plays, verifies, reprices nothing stale, settles and leaves escrow empty", async () => {
    let nowMs = START;
    const matches = new RecordingMatches();
    const markets = new InMemoryMarketsRepository();
    const bets = new InMemoryBetsRepository();
    const ledger = new InMemoryLedger("XTS");
    const fixtures = new DerivedFixturesRepository(matches);

    // The house and a player, funded the way the real paths expect.
    await ledger.post({
      idempotencyKey: "topup",
      kind: "bankroll_topup",
      refType: "bankroll",
      refId: null,
      entries: [
        { accountId: await ledger.treasuryAccount(), amountMinor: -50_000_000 },
        { accountId: await ledger.houseAccount(), amountMinor: 50_000_000 },
      ],
    });
    await ledger.post({
      idempotencyKey: "fund-user",
      kind: "deposit",
      refType: "deposit",
      refId: null,
      entries: [
        { accountId: await ledger.treasuryAccount(), amountMinor: -5_000_000 },
        { accountId: await ledger.userAccount("user-1"), amountMinor: 5_000_000 },
      ],
    });

    // The engine and settlement, as production wires them.
    engine = attachOddsEngine({ repository: markets, matches, simulations: 200 });
    unsubscribe = subscribeSettlement({
      matches,
      markets,
      bets,
      ledger,
      largePayoutMinor: 5_000_000,
    });

    const config: FixturesConfig = {
      enabled: true,
      target: 1,
      intervalMinutes: 5,
      betWindowSeconds: 60,
      maxConcurrent: 2,
      games: ["ludo"],
    };

    const scheduler = new HouseFixturesScheduler({
      config,
      repository: fixtures,
      matches,
      markets,
      launcher: {
        launch: async (input) => {
          const match = await matches.get(input.matchId);
          if (match === null) {
            throw new Error("the fixture vanished before it could be played");
          }

          const runner = new LudoMatchRunner({
            matchId: match.id,
            seed: input.seed,
            seedCommit: commitOf(input.seed),
            seats: ludoRunnerSeatsFromMatch(match),
            repository: matches,
            config: { players: 4 },
            botDelayMs: { min: 0, max: 1 },
            schedule: (delayMs, run) => {
              const timer = setTimeout(run, delayMs);
              return () => {
                clearTimeout(timer);
              };
            },
            logger: logger.child({ test: "fixture-lifecycle" }),
          });

          // Played in the background, exactly as the room would.
          void runner.start();
          return { roomId: `room-${match.id}` };
        },
      },
      lease: new InMemoryFixtureLease(),
      secret: SECRET,
      price: (matchId: string, game: FixtureGame) =>
        priceLudoMatch(matchId, {
          repository: markets,
          matches,
          simulations: 3_000,
          threads: 1,
        }).then((report) => ({
          matchId,
          game,
          simulations: report.gamesPlayed,
          reduced: report.fellBack,
          elapsedMs: report.elapsedMs,
        })),
      now: () => new Date(nowMs),
    });

    // 1. The scheduler creates and prices a fixture.
    const created = await scheduler.tick();
    expect(created.created).toBe(1);

    const [fixture] = await fixtures.listUpcoming();
    if (fixture === undefined) {
      throw new Error("no fixture was scheduled");
    }
    // The seed is derived from the row, and it opens the commitment on it.
    expect(verifyCommit(fixtureSeed(fixture.id, SECRET), fixture.seedCommit ?? "")).toBe(true);

    const priced = await markets.listForMatch(fixture.id);
    expect(priced.length).toBeGreaterThan(50);

    const winnerMarket = priced.find(
      (row) => row.marketType === "ludo_match_winner" && row.selectionKey === "red",
    );
    if (winnerMarket === undefined) {
      throw new Error("the fixture has no match winner market");
    }

    // A player backs red before the whistle, and the stake goes into escrow.
    const marketId = `${fixture.id}|ludo_match_winner|||red`;
    bets.addMarket({
      id: marketId,
      match_id: fixture.id,
      market_type: "ludo_match_winner",
      subject: "",
      line: null,
      selection_key: "red",
    });
    const bet: BetRow = {
      id: "bet-red",
      userId: "user-1",
      marketId,
      stakeMinor: 10_000,
      oddsLocked: winnerMarket.oddsDecimal,
      potentialPayoutMinor: Math.floor(10_000 * winnerMarket.oddsDecimal),
      status: "open",
      result: null,
      payoutMinor: null,
      idempotencyKey: "bet-red",
      placedAt: new Date(nowMs).toISOString(),
      settledAt: null,
      reviewReason: null,
    };
    bets.addBet(bet, marketId);
    await ledger.post({
      idempotencyKey: "stake",
      kind: "bet_stake",
      refType: "bet",
      refId: bet.id,
      entries: [
        { accountId: await ledger.userAccount("user-1"), amountMinor: -10_000 },
        { accountId: await ledger.escrowAccount(), amountMinor: 10_000 },
      ],
    });

    // 2. Its time comes. The scheduler closes the pre-match book and plays it.
    nowMs += 90_000;
    const started = await scheduler.tick();
    expect(started.started).toBe(1);

    // The markets that cannot be judged once the board moves are shut at the
    // whistle; the ones the catalogue marks live stay open for in-play betting.
    const afterStart = await markets.listForMatch(fixture.id);
    const preMatchOnly = afterStart.filter((row) => !row.isLive);
    expect(preMatchOnly.length).toBeGreaterThan(0);
    expect(preMatchOnly.every((row) => row.status !== "open")).toBe(true);
    expect(afterStart.some((row) => row.isLive && row.status === "open")).toBe(true);

    await until(async () => (await matches.get(fixture.id))?.status === "finished", 60_000);

    // 3. The result is the log's own, and it verifies.
    const finished = await matches.get(fixture.id);
    expect(finished?.seedReveal).toBe(fixtureSeed(fixture.id, SECRET));

    const verification = await verifyMatch(fixture.id, matches);
    expect(verification.failure).toBeNull();
    expect(verification.ok).toBe(true);

    // 4. The tick after the finish hands the match to settlement.
    nowMs += 1_000;
    const handedOver = await scheduler.tick();
    expect(handedOver.settled).toBe(1);

    await until(async () => (await bets.get(bet.id))?.status !== "open", 15_000);

    const settled = await bets.get(bet.id);
    expect(settled).not.toBeNull();
    expect(["won", "lost"]).toContain(settled?.status);

    // Settlement paid what the result said, and left nothing at risk.
    expect(await ledger.balanceOf(await ledger.escrowAccount())).toBe(0);

    const userBalance = await ledger.balanceOf(await ledger.userAccount("user-1"));
    const expected =
      settled?.status === "won"
        ? 5_000_000 - 10_000 + (settled.payoutMinor ?? 0)
        : 5_000_000 - 10_000;
    expect(userBalance).toBe(expected);

    // The books balance: every leg has a counter-leg.
    const total =
      userBalance +
      (await ledger.balanceOf(await ledger.houseAccount())) +
      (await ledger.balanceOf(await ledger.treasuryAccount())) +
      (await ledger.balanceOf(await ledger.escrowAccount())) +
      (await ledger.balanceOf(await ledger.withdrawalHoldAccount()));
    expect(total).toBe(0);

    // And a market left closed is never left open on a finished match.
    const finalRows = await markets.listForMatch(fixture.id);
    expect(finalRows.some((row) => row.status === "open")).toBe(false);

    // The report settlement would have produced, for the record.
    const report = await settleMatch(fixture.id, { matches, markets, bets, ledger });
    expect(report.verified).toBe(true);
    expect(report.settled).toBe(0); // already settled, and paid nobody twice
  }, 120_000);
});
