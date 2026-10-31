/**
 * The seat count decides the board.
 *
 * This file started as the reproduction of a live bug: a four-seat Ludo match
 * played through the room and database path ended after about a hundred and
 * twelve moves with a finishing order naming two of the four seats, while the
 * same engine given four named bots played more than four hundred moves and
 * filled all four places.
 *
 * The cause was in `LudoMatchRunner`: it built the board for four players and
 * then overwrote the seat list with whatever seats the database handed it, so a
 * short seat list ended the match early through `finishSeat`, and a two-seat
 * match put its players on adjacent seats instead of opposite ones. The runner
 * now takes its player count and its seat mapping from the seats themselves.
 *
 * These are requirements now, not observations.
 */

import { describe, expect, it } from "vitest";
import { commitOf, createMatchSeed } from "../../src/lib/fair-rng.js";
import { logger } from "../../src/lib/logger.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { LudoMatchRunner, type LudoRunnerSeat } from "../../src/rooms/ludo-match-runner.js";

interface Played {
  readonly seatsGiven: number;
  readonly playerIds: readonly string[];
  readonly stateSeats: readonly number[];
  readonly moves: number;
  readonly finishingOrder: readonly number[];
  readonly playersInConfig: number;
}

function quietSeat(seat: LudoRunnerSeat): LudoRunnerSeat {
  return {
    seat: seat.seat,
    playerId: seat.playerId,
    displayName: seat.displayName,
    isBot: seat.isBot,
    botPolicy: seat.botPolicy,
    profileId: seat.profileId,
  };
}

/**
 * Plays a Ludo match the way the room does: create it in the repository, read the
 * seats back, hand them to the runner, and wait for the end.
 */
async function play(options: { readonly names: readonly string[] }): Promise<Played> {
  const repository = new InMemoryMatchRepository();
  const seed = createMatchSeed();
  const match = await repository.create({
    game: "ludo",
    seedCommit: commitOf(seed),
    seats: options.names.map((displayName, index) => ({
      seat: (index + 1) as 1 | 2 | 3 | 4,
      botLevel: "club" as const,
      botPolicy: "cautious",
      displayName,
    })),
    config: { ludo: { players: options.names.length } },
  });

  // The database path: what came back is what the runner is handed, not what was
  // asked for.
  const stored = await repository.get(match.id);
  const seats = [...(stored?.seats ?? [])]
    .sort((left, right) => left.seat - right.seat)
    .map((seat) => quietSeat(seat));

  let done: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => {
    done = resolve;
  });

  const runner = new LudoMatchRunner({
    matchId: match.id,
    seed,
    seedCommit: commitOf(seed),
    seats,
    repository,
    // The runner takes the player count from the seats, so nothing is passed here.
    config: {},
    botDelayMs: { min: 0, max: 0 },
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
    logger,
    hooks: {
      onEnd: () => {
        done?.();
      },
    },
  });

  const stateSeats = [...runner.state.seats];
  const playersInConfig = runner.state.config.players;

  await runner.start();
  await ended;

  const signed = await repository.get(match.id);

  return {
    seatsGiven: stored?.seats.length ?? 0,
    playerIds: seats.map((seat) => seat.playerId),
    stateSeats,
    moves: runner.moveNumber,
    finishingOrder: [...(signed?.result?.finishingOrder ?? [])],
    playersInConfig,
  };
}

/** A seat list like the repository would hand over, for the error cases. */
function seatsFor(count: number, playerId: (index: number) => string): LudoRunnerSeat[] {
  return Array.from({ length: count }, (_unused, index) => ({
    seat: (index + 1) as 1 | 2 | 3 | 4,
    playerId: playerId(index),
    displayName: `Bot ${String(index + 1)}`,
    isBot: true,
    botPolicy: "cautious",
    profileId: null,
  }));
}

function runnerFor(seats: readonly LudoRunnerSeat[]): LudoMatchRunner {
  const seed = createMatchSeed();
  return new LudoMatchRunner({
    matchId: "match_seats",
    seed,
    seedCommit: commitOf(seed),
    seats,
    repository: new InMemoryMatchRepository(),
    config: {},
    botDelayMs: { min: 0, max: 0 },
    schedule: () => () => undefined,
    logger,
  });
}

describe("seat counts through the room path", () => {
  it("seats four named bots and names all four places", async () => {
    const played = await play({
      names: ["Cautious Bot", "Aggressive Bot", "Racer Bot", "Steady Bot"],
    });

    console.log(
      `four distinct : seats ${String(played.seatsGiven)}, state.seats [${played.stateSeats.join(", ")}], players ${String(played.playersInConfig)}, moves ${String(played.moves)}, finishing [${played.finishingOrder.join(", ")}]`,
    );

    expect(played.seatsGiven).toBe(4);
    expect(played.stateSeats).toEqual([0, 1, 2, 3]);
    expect(played.playersInConfig).toBe(4);
    expect(played.moves).toBeGreaterThan(300);
    expect(played.finishingOrder).toHaveLength(4);
    expect([...played.finishingOrder].sort()).toEqual([1, 2, 3, 4]);
  }, 120_000);

  it("gives four bots of one level four identities, so all four play", async () => {
    const played = await play({
      names: ["Cautious Bot", "Cautious Bot", "Cautious Bot", "Cautious Bot"],
    });

    console.log(
      `same name     : seats ${String(played.seatsGiven)}, players ${String(new Set(played.playerIds).size)}, state.seats [${played.stateSeats.join(", ")}], moves ${String(played.moves)}, finishing [${played.finishingOrder.join(", ")}]`,
    );

    expect(played.seatsGiven).toBe(4);
    expect(new Set(played.playerIds).size).toBe(4);
    expect(played.finishingOrder).toHaveLength(4);
    expect([...played.finishingOrder].sort()).toEqual([1, 2, 3, 4]);
  }, 120_000);

  it("seats two players opposite each other, and names both", async () => {
    const played = await play({ names: ["Cautious Bot", "Racer Bot"] });

    console.log(
      `two seats     : seats ${String(played.seatsGiven)}, state.seats [${played.stateSeats.join(", ")}], players ${String(played.playersInConfig)}, moves ${String(played.moves)}, finishing [${played.finishingOrder.join(", ")}]`,
    );

    expect(played.seatsGiven).toBe(2);
    // `seatsOf` puts two players opposite each other, 26 cells apart.
    expect(played.stateSeats).toEqual([0, 2]);
    expect(played.playersInConfig).toBe(2);
    expect(played.finishingOrder).toHaveLength(2);
    expect([...played.finishingOrder].sort()).toEqual([1, 2]);
  }, 120_000);

  it("refuses a seat count that is not two or four", () => {
    expect(() => runnerFor(seatsFor(3, (index) => `p${String(index)}`))).toThrow(
      /two or four players/,
    );
    expect(() => runnerFor(seatsFor(1, () => "p1"))).toThrow(/two or four players/);
  });

  it("refuses to seat the same player twice", () => {
    expect(() => runnerFor(seatsFor(2, () => "same-player"))).toThrow(/same player twice/);
    expect(() => runnerFor(seatsFor(4, () => "same-player"))).toThrow(/same player twice/);
  });
});
