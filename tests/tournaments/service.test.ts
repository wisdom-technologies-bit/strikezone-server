import { beforeEach, describe, expect, it } from "vitest";
import { commitOf } from "../../src/lib/fair-rng.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { clearSubscribers } from "../../src/lib/events.js";
import { InMemoryLedger } from "../../src/wallet/ledger.js";
import type { LaunchInput, MatchLauncher } from "../../src/tournaments/launcher.js";
import { InMemoryTournamentRepository } from "../../src/tournaments/repository.js";
import { TournamentService } from "../../src/tournaments/service.js";
import type { MatchConfig, TournamentConfig } from "../../src/tournaments/types.js";

/**
 * The whole lifecycle, end to end, with no database, no wallet service and no
 * WebSocket: an in-memory ledger and tournament store, the real match store, and
 * a launcher that plays each match out in a way the test chooses.
 */

/** Plays a launched match out, choosing the winner the test asks for. */
class FakeLauncher implements MatchLauncher {
  readonly launched: LaunchInput[] = [];
  #winner: (input: LaunchInput) => "seat1" | "seat2" | "none";
  #join: boolean;

  constructor(options: {
    readonly matches: InMemoryMatchRepository;
    readonly winner?: (input: LaunchInput) => "seat1" | "seat2" | "none";
    readonly join?: boolean;
  }) {
    this.#matches = options.matches;
    this.#winner = options.winner ?? (() => "seat1");
    this.#join = options.join ?? true;
  }

  readonly #matches: InMemoryMatchRepository;

  async launch(input: LaunchInput): Promise<{ roomId: string }> {
    this.launched.push(input);

    const choice = this.#winner(input);
    if (choice === "none") {
      // The room exists but nobody turns up: this is what a walkover is for.
      return { roomId: `room_${input.matchId}` };
    }

    const match = await this.#matches.get(input.matchId);
    const at = new Date().toISOString();

    await this.#matches.markLive(input.matchId, {
      seedCommit: match?.seedCommit ?? commitOf(input.seed),
      startedAt: at,
    });

    if (this.#join) {
      await this.#matches.recordJoin(input.matchId, 1, at);
      await this.#matches.recordJoin(input.matchId, 2, at);
    }

    await this.#matches.finish(input.matchId, {
      seedReveal: input.seed,
      result: {
        winnerSeat: choice === "seat1" ? 1 : 2,
        winnerColour: choice === "seat1" ? "white" : "black",
        scores: choice === "seat1" ? { white: 25, black: 12 } : { white: 12, black: 25 },
        boards: 1,
        shots: 40,
        reason: "scored",
        seedDraws: 100,
      },
      resultSignature: "signature",
      logHeadHash: "head",
      endedAt: at,
    });

    return { roomId: `room_${input.matchId}` };
  }
}

const MATCH: MatchConfig = { targetPoints: 25, boardsPerMatch: 1, turnSeconds: 30 };

function config(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    game: "carrom",
    format: "single_elimination",
    minPlayers: 4,
    maxPlayers: 8,
    entryFeeMinor: 1_000,
    rakeBps: 1_000,
    prizeSplit: [60, 30, 10],
    botPrizePolicy: "next_human",
    fillWithBots: false,
    botLevel: "club",
    registrationOpensAt: "2026-10-29T09:00:00.000Z",
    registrationClosesAt: "2026-10-29T09:55:00.000Z",
    startsAt: "2026-10-29T10:00:00.000Z",
    walkoverSeconds: 180,
    match: MATCH,
    allowSpectators: true,
    ...overrides,
  };
}

interface Harness {
  readonly tournaments: InMemoryTournamentRepository;
  readonly matches: InMemoryMatchRepository;
  readonly ledger: InMemoryLedger;
  readonly launcher: FakeLauncher;
  readonly service: TournamentService;
  readonly clock: { value: Date };
}

async function harness(options?: {
  readonly winner?: (input: LaunchInput) => "seat1" | "seat2" | "none";
  readonly join?: boolean;
  readonly startingBalance?: number;
}): Promise<Harness> {
  const tournaments = new InMemoryTournamentRepository();
  const matches = new InMemoryMatchRepository();
  const ledger = new InMemoryLedger("XTS");
  const launcher = new FakeLauncher({
    matches,
    winner: options?.winner,
    join: options?.join,
  });

  const clock = { value: new Date("2026-10-29T09:30:00.000Z") };

  const service = new TournamentService({
    repository: tournaments,
    matches,
    ledger,
    launcher,
    now: () => clock.value,
    newSeed: () => "0123456789abcdef0123456789abcdef",
  });

  const house = await ledger.houseAccount();
  for (let index = 1; index <= 8; index += 1) {
    const wallet = await ledger.userAccount(`profile_h${String(index)}`);
    await ledger.post({
      idempotencyKey: `seed-wallet-${String(index)}`,
      kind: "deposit",
      entries: [
        { accountId: house, amountMinor: -(options?.startingBalance ?? 5_000) },
        { accountId: wallet, amountMinor: options?.startingBalance ?? 5_000 },
      ],
    });
  }

  return { tournaments, matches, ledger, launcher, service, clock };
}

/** Registers `count` humans, starts the tournament, and plays it out. */
async function playOut(
  h: Harness,
  tournamentId: string,
  options?: { readonly maxTicks?: number },
): Promise<void> {
  const maxTicks = options?.maxTicks ?? 40;

  // Matches are due at the start time, so move to it before playing.
  const start = Date.parse("2026-10-29T10:00:01.000Z");
  if (h.clock.value.getTime() < start) {
    h.clock.value = new Date(start);
  }

  for (let tick = 0; tick < maxTicks; tick += 1) {
    await h.service.launchDue(tournamentId);
    await h.service.settle(tournamentId);

    const tournament = await h.tournaments.get(tournamentId);
    if (tournament?.status === "finished" || tournament?.status === "cancelled") {
      return;
    }
    // Ten seconds a tick, so due times and walkover windows come round.
    h.clock.value = new Date(h.clock.value.getTime() + 10_000);
  }
}

async function createOpen(h: Harness, overrides: Partial<TournamentConfig> = {}): Promise<string> {
  const created = await h.service.create({ name: "Test Cup", config: config(overrides) });
  await h.service.open(created.id);
  return created.id;
}

async function registerAll(h: Harness, tournamentId: string, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await h.service.register({
      tournamentId,
      profileId: `profile_h${String(index)}`,
      displayName: `Human ${String(index)}`,
    });
  }
}

describe("the tournament lifecycle", () => {
  beforeEach(() => {
    clearSubscribers();
  });

  it("runs eight players to a champion and pays the prizes", async () => {
    const h = await harness();
    const id = await createOpen(h, { minPlayers: 8, maxPlayers: 8 });
    await registerAll(h, id, 8);

    await h.service.start(id);

    const started = await h.tournaments.get(id);
    expect(started?.status).toBe("running");
    expect(started?.prizePoolMinor).toBe(8_000);

    await playOut(h, id);

    const finished = await h.tournaments.get(id);
    expect(finished?.status).toBe("finished");
    expect(finished?.championPlayerId).not.toBeNull();

    // Rake 800, then 4320 / 2160 / 720.
    expect(finished?.payouts?.map((payout) => payout.amountMinor)).toEqual([4_320, 2_160, 720]);

    const pool = await h.ledger.prizePoolAccount(id);
    expect(await h.ledger.balanceOf(pool)).toBe(0);

    const house = await h.ledger.houseAccount();
    // The house funded eight wallets with 5,000 each and took 800 of rake.
    expect(await h.ledger.balanceOf(house)).toBe(-40_000 + 800);

    // Every match the bracket created was played through the launcher.
    expect(h.launcher.launched).toHaveLength(7);
  });

  it("advances a bye without a match", async () => {
    const h = await harness();
    const id = await createOpen(h, { minPlayers: 5, maxPlayers: 8 });
    await registerAll(h, id, 5);

    await h.service.start(id);

    const positions = await h.tournaments.listPositions(id);
    const byes = positions.filter(
      (position) => position.round === 1 && position.winnerPlayerId !== null,
    );
    expect(byes).toHaveLength(3);
    expect(byes.every((position) => position.matchId === null)).toBe(true);

    // Three byes means only one first-round match.
    await h.service.launchDue(id);
    expect(h.launcher.launched).toHaveLength(1);
  });

  it("decides a walkover when a human never turns up", async () => {
    const h = await harness({ winner: () => "none", join: false });
    const id = await createOpen(h, {
      minPlayers: 2,
      maxPlayers: 2,
      fillWithBots: true,
    });
    // One human enters; a bot fills the other seat and turns up by definition.
    await registerAll(h, id, 1);
    await h.service.start(id);

    h.clock.value = new Date("2026-10-29T10:00:05.000Z");
    await h.service.launchDue(id);
    expect(h.launcher.launched).toHaveLength(1);

    // One tick inside the window: nothing is decided yet.
    await h.service.settle(id);
    let positions = await h.tournaments.listPositions(id);
    expect(positions[0]?.winnerPlayerId).toBeNull();

    // Past the three minute window.
    h.clock.value = new Date(h.clock.value.getTime() + 181_000);
    await h.service.settle(id);

    positions = await h.tournaments.listPositions(id);
    expect(positions[0]?.isWalkover).toBe(true);
    expect(positions[0]?.winnerPlayerId).not.toBeNull();

    const finished = await h.tournaments.get(id);
    expect(finished?.status).toBe("finished");
    expect(finished?.championPlayerId).toBe(positions[0]?.winnerPlayerId);
  });

  it("refunds every entry fee when a tournament is cancelled, to the last unit", async () => {
    const h = await harness();
    const id = await createOpen(h);
    await registerAll(h, id, 4);

    const pool = await h.ledger.prizePoolAccount(id);
    expect(await h.ledger.balanceOf(pool)).toBe(4_000);

    const before = new Map<string, number>();
    for (let index = 1; index <= 4; index += 1) {
      const wallet = await h.ledger.userAccount(`profile_h${String(index)}`);
      before.set(wallet, await h.ledger.balanceOf(wallet));
    }

    const result = await h.service.cancel(id, "test");

    expect(result.refundedEntries).toBe(4);
    expect(result.refundedMinor).toBe(4_000);

    // The refunds sum to exactly what was paid in.
    const payments = await h.ledger.transactionsFor("tournament", id);
    const paidIn = payments
      .filter((transaction) => transaction.kind === "tournament_entry")
      .reduce(
        (sum, transaction) =>
          sum + transaction.entries.filter((entry) => entry.amountMinor > 0).length * 1_000,
        0,
      );
    const refunds = await h.ledger.transactionsFor("tournament_refund", id);
    const refunded = refunds.reduce(
      (sum, transaction) =>
        sum +
        transaction.entries
          .filter((entry) => entry.amountMinor > 0)
          .reduce((legs, entry) => legs + entry.amountMinor, 0),
      0,
    );

    expect(refunded).toBe(paidIn);
    expect(await h.ledger.balanceOf(pool)).toBe(0);

    for (const [wallet, balance] of before) {
      expect(await h.ledger.balanceOf(wallet)).toBe(balance + 1_000);
    }

    const cancelled = await h.tournaments.get(id);
    expect(cancelled?.status).toBe("cancelled");
  });

  it("fills the field with bots and passes a bot prize down to a human", async () => {
    const h = await harness({
      // Bots win whenever they play a human, so the champion is a bot.
      winner: (input) => {
        const bots = input.seats.filter((seat) => seat.kind === "bot").length;
        if (bots === 1) {
          return input.seats[0]?.kind === "bot" ? "seat1" : "seat2";
        }
        return "seat1";
      },
    });

    const id = await createOpen(h, {
      minPlayers: 4,
      maxPlayers: 4,
      fillWithBots: true,
      botPrizePolicy: "next_human",
    });
    await registerAll(h, id, 2);

    await h.service.start(id);

    const entries = await h.tournaments.listEntries(id);
    expect(entries).toHaveLength(4);
    expect(entries.filter((entry) => entry.isBot)).toHaveLength(2);

    await playOut(h, id);

    const finished = await h.tournaments.get(id);
    expect(finished?.status).toBe("finished");

    const pool = await h.ledger.prizePoolAccount(id);
    expect(await h.ledger.balanceOf(pool)).toBe(0);

    // The pool was two entries at 1,000: 2,000 in, 200 of rake, 1,800 to the humans.
    const payouts = finished?.payouts ?? [];
    const paid = payouts.reduce((sum, payout) => sum + payout.amountMinor, 0);
    const house = await h.ledger.houseAccount();
    const houseGain = -40_000 + 200;

    expect(paid).toBe(1_800);
    expect(await h.ledger.balanceOf(house)).toBe(houseGain);

    // Every payout went to a human: no prize was ever posted to a bot.
    for (const payout of payouts) {
      const wallet = payout.playerId;
      expect(wallet).not.toContain("bot_");
    }
    expect(payouts.some((payout) => payout.viaBotPlayerId !== null)).toBe(true);
  });

  it("recovers in the middle of round two and finishes from the database alone", async () => {
    const h = await harness();
    const id = await createOpen(h, { minPlayers: 8, maxPlayers: 8 });
    await registerAll(h, id, 8);
    await h.service.start(id);
    h.clock.value = new Date("2026-10-29T10:00:05.000Z");

    // Round one played and advanced.
    await h.service.launchDue(id);
    await h.service.settle(id);

    // Round two launched: its matches have finished in the match store, but the
    // bracket has not been told yet. This is the crash point.
    await h.service.launchDue(id);

    let positions = await h.tournaments.listPositions(id);
    expect(
      positions.filter((position) => position.round === 1 && position.winnerPlayerId !== null),
    ).toHaveLength(4);
    const roundTwo = positions.filter((position) => position.round === 2);
    expect(roundTwo).toHaveLength(2);
    expect(roundTwo.every((position) => position.seat1PlayerId !== null)).toBe(true);
    expect(roundTwo.every((position) => position.seat2PlayerId !== null)).toBe(true);
    expect(roundTwo.every((position) => position.winnerPlayerId === null)).toBe(true);
    expect(roundTwo.every((position) => position.matchId !== null)).toBe(true);

    // The process dies here. A new service is built from the same stores, with
    // nothing carried over in memory, and picks the tournament up where it was.
    const restarted = new TournamentService({
      repository: h.tournaments,
      matches: h.matches,
      ledger: h.ledger,
      launcher: h.launcher,
      now: () => h.clock.value,
      newSeed: () => "fedcba9876543210fedcba9876543210",
    });

    for (let tick = 0; tick < 40; tick += 1) {
      await restarted.launchDue(id);
      await restarted.settle(id);
      const tournament = await h.tournaments.get(id);
      if (tournament?.status === "finished") {
        break;
      }
      h.clock.value = new Date(h.clock.value.getTime() + 10_000);
    }

    const finished = await h.tournaments.get(id);
    expect(finished?.status).toBe("finished");
    expect(finished?.championPlayerId).not.toBeNull();
    expect(finished?.payouts).toHaveLength(3);

    positions = await h.tournaments.listPositions(id);
    expect(positions.filter((position) => position.winnerPlayerId !== null)).toHaveLength(7);

    const pool = await h.ledger.prizePoolAccount(id);
    expect(await h.ledger.balanceOf(pool)).toBe(0);
  });

  it("pays once, however often it is asked to settle", async () => {
    const h = await harness();
    const id = await createOpen(h, { minPlayers: 4, maxPlayers: 4 });
    await registerAll(h, id, 4);
    await h.service.start(id);
    await playOut(h, id);

    const before = await h.tournaments.get(id);
    expect(before?.status).toBe("finished");

    await h.service.settle(id);
    await h.service.settle(id);

    const after = await h.tournaments.get(id);
    expect(after?.payouts).toEqual(before?.payouts);

    const payouts = await h.ledger.transactionsFor("tournament", id);
    const prizeTransactions = payouts.filter(
      (transaction) => transaction.kind === "tournament_prize",
    );
    expect(prizeTransactions).toHaveLength(1);

    const pool = await h.ledger.prizePoolAccount(id);
    expect(await h.ledger.balanceOf(pool)).toBe(0);
  });

  it("refuses a registration the wallet cannot cover", async () => {
    const h = await harness({ startingBalance: 500 });
    const id = await createOpen(h);

    await expect(
      h.service.register({ tournamentId: id, profileId: "profile_h1", displayName: "Human 1" }),
    ).rejects.toMatchObject({ code: "insufficient_funds" });

    expect(await h.tournaments.listEntries(id)).toHaveLength(0);
  });

  it("refunds a withdrawal and closes the door at the deadline", async () => {
    const h = await harness();
    const id = await createOpen(h);
    await registerAll(h, id, 3);

    const wallet = await h.ledger.userAccount("profile_h3");
    await h.service.withdraw({ tournamentId: id, profileId: "profile_h3" });

    expect(await h.ledger.balanceOf(wallet)).toBe(5_000);
    expect(
      (await h.tournaments.listEntries(id)).filter((e) => e.status !== "withdrawn"),
    ).toHaveLength(2);

    h.clock.value = new Date("2026-10-29T09:56:00.000Z");
    await expect(
      h.service.withdraw({ tournamentId: id, profileId: "profile_h1" }),
    ).rejects.toMatchObject({ code: "registration_closed" });
  });
});
