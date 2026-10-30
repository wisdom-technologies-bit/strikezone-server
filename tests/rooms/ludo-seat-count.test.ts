/**
 * The seat-count bug, reproduced rather than guessed at.
 *
 * A four-seat Ludo match played through the room and database path was ending
 * after about a hundred and twelve moves with a finishing order naming two of
 * the four seats. The in-memory engine, given four named bots, plays more than
 * four hundred moves and fills all four places.
 *
 * The suspicion: `LudoMatchRunner` builds its board for four players and then
 * overwrites the seat list with whatever the database handed it. `finishSeat`
 * decides the match is over when one listed seat is still racing, so a seat list
 * shorter than the board ends the match early and the places it records are only
 * the seats it knew about.
 *
 * These are reproductions, not requirements. Each one logs what the seat list
 * actually became, and asserts the observed behaviour so the failure is a number
 * in the output rather than a hunch. Step two turns them into requirements.
 */

import { describe, expect, it } from "vitest";
import { commitOf, createMatchSeed } from "../../src/lib/fair-rng.js";
import { logger } from "../../src/lib/logger.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { LudoMatchRunner, type LudoRunnerSeat } from "../../src/rooms/ludo-match-runner.js";

interface Played {
  readonly seatsGiven: number;
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
async function play(options: {
  readonly names: readonly string[];
  readonly config?: { readonly players?: number };
}): Promise<Played> {
  const repository = new InMemoryMatchRepository();
  const seed = createMatchSeed();
  const players = (options.config?.players ?? options.names.length) as 2 | 4;
  const match = await repository.create({
    game: "ludo",
    seedCommit: commitOf(seed),
    seats: options.names.map((displayName, index) => ({
      seat: (index + 1) as 1 | 2 | 3 | 4,
      botLevel: "club" as const,
      botPolicy: "cautious",
      displayName,
    })),
    config: { ludo: { players } },
  });

  // The database path: what came back is what the runner is handed, not what was
  // asked for.
  const stored = await repository.get(match.id);
  const seatsGiven = stored?.seats.length ?? 0;
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
    config: { players },
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

  // Logged at construction, which is the moment the hypothesis is about.
  const stateSeats = [...runner.state.seats];
  const playersInConfig = runner.state.config.players;

  await runner.start();
  await ended;

  return {
    seatsGiven,
    stateSeats,
    moves: runner.moveNumber,
    finishingOrder: [...runner.state.finishingOrder],
    playersInConfig,
  };
}

describe("seat counts through the room path", () => {
  it("seats four named bots and plays all four places", async () => {
    const played = await play({
      names: ["Cautious Bot", "Aggressive Bot", "Racer Bot", "Steady Bot"],
    });

    console.log(
      `four distinct : seats given ${String(played.seatsGiven)}, state.seats [${played.stateSeats.join(", ")}], config.players ${String(played.playersInConfig)}, moves ${String(played.moves)}, finishing [${played.finishingOrder.join(", ")}]`,
    );

    expect(played.seatsGiven).toBe(4);
    expect(played.stateSeats).toHaveLength(4);
    expect(played.finishingOrder).toHaveLength(4);
    expect(played.moves).toBeGreaterThan(300);
  }, 120_000);

  it("seats four bots that share a display name, the way a bot keyed by name collapses", async () => {
    const played = await play({
      names: ["Cautious Bot", "Cautious Bot", "Cautious Bot", "Cautious Bot"],
    });

    console.log(
      `same name     : seats given ${String(played.seatsGiven)}, state.seats [${played.stateSeats.join(", ")}], config.players ${String(played.playersInConfig)}, moves ${String(played.moves)}, finishing [${played.finishingOrder.join(", ")}]`,
    );

    // What the database actually kept, which is the number the hypothesis turns on.
    expect(played.seatsGiven).toBeGreaterThan(0);
  }, 120_000);

  it("seats two players and shows which engine seats they occupy", async () => {
    const played = await play({ names: ["Cautious Bot", "Racer Bot"], config: { players: 2 } });

    console.log(
      `two seats     : seats given ${String(played.seatsGiven)}, state.seats [${played.stateSeats.join(", ")}], config.players ${String(played.playersInConfig)}, moves ${String(played.moves)}, finishing [${played.finishingOrder.join(", ")}]`,
    );

    // `seatsOf` puts two players on engine seats 0 and 2, opposite each other.
    // The runner maps database seats one and two to engine seats 0 and 1, so this
    // records which of the two the board actually holds.
    console.log(`two seats     : engine seats the board was built with [${played.stateSeats.join(", ")}]`);
    expect(played.seatsGiven).toBe(2);
  }, 120_000);
});
