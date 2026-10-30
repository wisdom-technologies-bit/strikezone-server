import { describe, expect, it } from "vitest";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { InMemoryMarketsRepository } from "../../src/odds/markets-store.js";
import { attachOddsEngine } from "../../src/odds/live.js";
import { publish } from "../../src/lib/events.js";

/**
 * The book in play, without a room: the engine is driven by the same events the
 * room publishes.
 */
describe("live repricing", () => {
  it("keeps a finished match's markets closed", { timeout: 60_000 }, async () => {
    const matches = new InMemoryMatchRepository();
    const repository = new InMemoryMarketsRepository();

    const match = await matches.create({
      seedCommit: "0".repeat(64),
      config: { carrom: {} },
      seats: [
        { seat: 1, botLevel: "club" },
        { seat: 2, botLevel: "club" },
      ],
    });

    const timers: (() => void)[] = [];
    const engine = attachOddsEngine({
      repository,
      matches,
      simulations: 40,
      preMatchSimulations: 40,
      repriceIntervalMs: 0,
      suspensionMs: 10,
      clock: {
        setTimeout: (callback) => {
          timers.push(callback);
          return { cancel: () => undefined };
        },
      },
    });

    publish("match.created", {
      matchId: match.id,
      game: "carrom",
      tournamentId: null,
      playerIds: match.seats.map((seat) => seat.playerId),
      isBot: [true, true],
    });
    await engine.idle();

    publish("match.shot", { matchId: match.id, game: "carrom", seat: 1, shotNumber: 1 });
    await engine.idle();

    const suspended = await repository.listForMatch(match.id);
    expect(suspended.length).toBeGreaterThan(0);
    expect(new Set(suspended.map((row) => row.status))).toEqual(new Set(["suspended"]));

    publish("match.finished", {
      matchId: match.id,
      game: "carrom",
      tournamentId: null,
      winnerPlayerId: null,
      loserPlayerId: null,
      reason: "scored",
      scores: { white: 0, black: 0 },
    });
    await engine.idle();

    // The suspension timer from the shot fires after the finish: it must not
    // reopen a book whose match is over.
    for (const timer of timers) {
      timer();
    }
    await engine.idle();

    const closed = await repository.listForMatch(match.id);
    expect(new Set(closed.map((row) => row.status))).toEqual(new Set(["closed"]));

    engine.stop();
  });
});
