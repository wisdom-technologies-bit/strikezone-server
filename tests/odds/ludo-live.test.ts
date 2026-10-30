import { describe, expect, it } from "vitest";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { InMemoryMarketsRepository } from "../../src/odds/markets-store.js";
import { attachOddsEngine } from "../../src/odds/live.js";
import { publish, subscribe } from "../../src/lib/events.js";
import { priceLudoMatch } from "../../src/odds/ludo-pricer.js";
import { createInitialState, applyRoll, cautiousChooser } from "../../src/engines/ludo/index.js";
import { seededUniform } from "../../src/odds/ludo-sim.js";

/**
 * A Ludo book in play, driven by the same events the room publishes.
 *
 * The rules are Carrom's rules: a shot suspends the whole book, the reprice runs
 * underneath the suspension, and the reopen timer never outlives the match. What
 * is Ludo's own is the conditioning: a live price resumes from the board, so a
 * seat with three tokens home is not priced as if the game had not started.
 */
describe("live ludo repricing", () => {
  const SIMS = 60;

  async function ludoMatch(): Promise<{
    matches: InMemoryMatchRepository;
    repository: InMemoryMarketsRepository;
    matchId: string;
  }> {
    const matches = new InMemoryMatchRepository();
    const repository = new InMemoryMarketsRepository();
    const match = await matches.create({
      game: "ludo",
      seedCommit: "0".repeat(64),
      seats: [
        { seat: 1, botLevel: "club", botPolicy: "cautious", displayName: "Red" },
        { seat: 2, botLevel: "club", botPolicy: "cautious", displayName: "Green" },
        { seat: 3, botLevel: "club", botPolicy: "cautious", displayName: "Yellow" },
        { seat: 4, botLevel: "club", botPolicy: "cautious", displayName: "Blue" },
      ],
    });
    return { matches, repository, matchId: match.id };
  }

  /** The engine, with a clock whose timers fire when the test says so. */
  function engineFor(
    matches: InMemoryMatchRepository,
    repository: InMemoryMarketsRepository,
  ): { engine: ReturnType<typeof attachOddsEngine>; timers: (() => void)[] } {
    const timers: (() => void)[] = [];
    const engine = attachOddsEngine({
      repository,
      matches,
      simulations: SIMS,
      preMatchSimulations: SIMS,
      repriceIntervalMs: 0,
      suspensionMs: 10,
      clock: {
        setTimeout: (callback) => {
          timers.push(callback);
          return { cancel: () => undefined };
        },
      },
    });
    return { engine, timers };
  }

  it(
    "prices a new ludo match, suspends it on a move and reopens it",
    { timeout: 60_000 },
    async () => {
      const { matches, repository, matchId } = await ludoMatch();
      const { engine, timers } = engineFor(matches, repository);

      publish("match.created", {
        matchId,
        game: "ludo",
        tournamentId: null,
        playerIds: (await matches.get(matchId))?.seats.map((seat) => seat.playerId) ?? [],
        isBot: [true, true, true, true],
      });
      await engine.idle();

      const priced = await repository.listForMatch(matchId);
      expect(priced.length).toBeGreaterThanOrEqual(240);
      expect(new Set(priced.map((row) => row.status))).toEqual(new Set(["open"]));

      publish("match.shot", { matchId, game: "ludo", seat: 1, shotNumber: 1 });
      await engine.idle();

      const suspended = await repository.listForMatch(matchId);
      expect(new Set(suspended.map((row) => row.status))).toEqual(new Set(["suspended"]));

      // The suspension timer reopens the book once the price has landed.
      for (const timer of timers) {
        timer();
      }
      await engine.idle();

      const reopened = await repository.listForMatch(matchId);
      expect(new Set(reopened.map((row) => row.status))).toEqual(new Set(["open"]));
      engine.stop();
    },
  );

  it("closes a finished ludo match and hands its facts over", { timeout: 60_000 }, async () => {
    const { matches, repository, matchId } = await ludoMatch();
    const { engine, timers } = engineFor(matches, repository);

    publish("match.created", {
      matchId,
      game: "ludo",
      tournamentId: null,
      playerIds: [],
      isBot: [true, true, true, true],
    });
    await engine.idle();

    publish("match.shot", { matchId, game: "ludo", seat: 1, shotNumber: 1 });
    await engine.idle();

    const handed: { matchId: string; game: string; winner: unknown }[] = [];
    const unsubscribe = subscribe("markets.ready_to_settle", (payload) => {
      handed.push({ matchId: payload.matchId, game: payload.game, winner: payload.winner });
    });

    publish("match.finished", {
      matchId,
      game: "ludo",
      tournamentId: null,
      winnerPlayerId: null,
      loserPlayerId: null,
      reason: "scored",
      scores: { white: 0, black: 0 },
    });
    // A finish with no log ends as an abandoned game, which is a void rather than
    // a crash: the handover still happens, and the book still closes.
    await engine.idle();
    unsubscribe();

    expect(new Set((await repository.listForMatch(matchId)).map((row) => row.status))).toEqual(
      new Set(["closed"]),
    );
    expect(handed).toHaveLength(1);
    expect(handed[0]?.game).toBe("ludo");

    // The suspension timer from the shot fires after the finish: it must not
    // reopen a book whose match is over.
    for (const timer of timers) {
      timer();
    }
    await engine.idle();
    expect(new Set((await repository.listForMatch(matchId)).map((row) => row.status))).toEqual(
      new Set(["closed"]),
    );
    engine.stop();
  });

  it("prices from the board, not the opening", { timeout: 120_000 }, async () => {
    const { matches, matchId } = await ludoMatch();
    const repository = new InMemoryMarketsRepository();

    // Play one seat into a strong position: three tokens home, no capture against
    // it. A pre-match price would call that a quarter.
    const random = seededUniform("conditioning");
    let state = createInitialState({ players: 4 });
    /** Tokens a seat has home: progress 57 is home, per the engine's own scale. */
    const homeOf = (candidate: typeof state, seat: number): number =>
      candidate.tokens.slice(seat * 4, seat * 4 + 4).filter((progress) => progress === 57).length;
    let guard = 0;
    while (homeOf(state, 0) < 3 && state.status === "playing" && guard < 8_000) {
      const roll = Math.floor(random() * 6) + 1;
      state = applyRoll(state, roll, cautiousChooser).state;
      guard += 1;
    }
    expect(homeOf(state, 0)).toBeGreaterThanOrEqual(2);

    const report = await priceLudoMatch(matchId, {
      matches,
      repository,
      simulations: SIMS,
      threads: 1,
      resume: state,
      write: false,
    });

    const winner = report.markets.find((market) => market.marketType === "ludo_match_winner");
    expect(winner).toBeDefined();

    // The seat with the most tokens home is the one the board favours, and a
    // price that resumes from here must say so: a pre-match price would have all
    // four levels at a quarter.
    const homeBySeat = [0, 1, 2, 3].map((seat) => homeOf(state, seat));
    const leader = homeBySeat.indexOf(Math.max(...homeBySeat));
    const bySeat = (seat: number) =>
      winner?.selections.find(
        (selection) => selection.selectionKey === ["red", "green", "yellow", "blue"][seat],
      )?.fairProbability ?? 0;

    expect(bySeat(leader)).toBeGreaterThan(0.4);
    for (const seat of [0, 1, 2, 3]) {
      if (seat !== leader) {
        expect(bySeat(leader)).toBeGreaterThan(bySeat(seat));
      }
    }

    // A seat still in its yard is not priced as a contender.
    const yardSeat = state.tokens.findIndex((progress) => progress === -1);
    if (yardSeat >= 0) {
      expect(bySeat(Math.floor(yardSeat / 4))).toBeLessThan(0.5);
    }
  });
});
