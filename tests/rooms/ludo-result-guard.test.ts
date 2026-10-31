import { describe, expect, it } from "vitest";
import { commitOf, createMatchSeed } from "../../src/lib/fair-rng.js";
import { logger } from "../../src/lib/logger.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { LudoMatchRunner, type LudoRunnerSeat } from "../../src/rooms/ludo-match-runner.js";
import { resultProblem } from "../../src/rooms/ludo-result-guard.js";

/**
 * A signed Ludo result is what the books settle against.
 *
 * These tests are about refusing to sign, which is the only safe answer when the
 * board and the result disagree. The check is a pure function so each rule can be
 * broken on purpose, and the runner is tested end to end for the two outcomes
 * that matter: a complete result is written, an incomplete one is abandoned.
 */

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

interface Played {
  readonly finished: boolean;
  readonly abandonedWith: string | null;
  readonly result: unknown;
  readonly moves: number;
}

/**
 * Plays a match through the repository, exactly as the room does. `seatNumbers`
 * is what the repository is asked to seat, which is how a corrupted seat table is
 * simulated: the match exists, its seat list is wrong.
 */
async function play(options: {
  readonly seatNumbers: readonly (1 | 2 | 3 | 4)[];
}): Promise<Played> {
  const repository = new InMemoryMatchRepository();
  const seed = createMatchSeed();
  const match = await repository.create({
    game: "ludo",
    seedCommit: commitOf(seed),
    seats: options.seatNumbers.map((seat, index) => ({
      seat,
      botLevel: "club" as const,
      botPolicy: "cautious",
      displayName: `Guard Bot ${String(index + 1)}`,
    })),
    config: { ludo: { players: options.seatNumbers.length } },
  });

  const stored = await repository.get(match.id);
  const seats = [...(stored?.seats ?? [])]
    .sort((left, right) => left.seat - right.seat)
    .map((seat) => quietSeat(seat));

  let done: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => {
    done = resolve;
  });
  let abandonedWith: string | null = null;

  const runner = new LudoMatchRunner({
    matchId: match.id,
    seed,
    seedCommit: commitOf(seed),
    seats,
    repository,
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
      onAbandoned: (info) => {
        abandonedWith = info.reason;
        done?.();
      },
    },
  });

  await runner.start();
  await ended;
  const signed = await repository.get(match.id);

  return {
    finished: signed?.result !== null && signed?.result !== undefined,
    abandonedWith,
    result: signed?.result ?? null,
    moves: runner.moveNumber,
  };
}

describe("the result guard", () => {
  it("signs a complete four seat result", async () => {
    const played = await play({ seatNumbers: [1, 2, 3, 4] });

    expect(played.abandonedWith).toBeNull();
    expect(played.finished).toBe(true);
    const result = played.result as { finishingOrder: number[]; tokensHome: number[] };
    expect(result.finishingOrder).toHaveLength(4);
    expect([...result.finishingOrder].sort()).toEqual([1, 2, 3, 4]);
    expect(result.tokensHome).toHaveLength(4);
    expect(played.moves).toBeGreaterThan(300);
  }, 120_000);

  it("refuses and abandons when the seat table repeats a seat, so a place is missing", async () => {
    const played = await play({ seatNumbers: [1, 1, 2, 3] });

    expect(played.finished).toBe(false);
    expect(played.abandonedWith).not.toBeNull();
    expect(played.abandonedWith).toMatch(/seats|seat/);
  }, 120_000);

  it("refuses a result that names one seat fewer than the match", () => {
    const seats = [
      { seat: 1 as const, engineSeat: 0 },
      { seat: 2 as const, engineSeat: 1 },
      { seat: 3 as const, engineSeat: 2 },
      { seat: 4 as const, engineSeat: 3 },
    ];
    const state = {
      config: { tokensPerPlayer: 4 },
      tokens: Array.from({ length: 16 }, () => 57),
    } as unknown as Parameters<typeof resultProblem>[0]["state"];

    const problem = resultProblem({
      result: {
        finishingOrder: [1, 2, 3],
        tokensHome: [4, 4, 4, 0],
        shots: 400,
      } as unknown as Parameters<typeof resultProblem>[0]["result"],
      state,
      seats,
    });

    expect(problem).toBe("the finishing order names 3 of 4 seats");
  });

  it("refuses a result that names a seat twice", () => {
    const seats = [
      { seat: 1 as const, engineSeat: 0 },
      { seat: 2 as const, engineSeat: 1 },
    ];
    const state = {
      config: { tokensPerPlayer: 4 },
      tokens: Array.from({ length: 16 }, () => 57),
    } as unknown as Parameters<typeof resultProblem>[0]["state"];

    const problem = resultProblem({
      result: {
        finishingOrder: [1, 1],
        tokensHome: [4, 4],
        shots: 100,
      } as unknown as Parameters<typeof resultProblem>[0]["result"],
      state,
      seats,
    });

    expect(problem).toBe("the finishing order names a seat twice");
  });

  it("refuses a token count that disagrees with the board", () => {
    // A two seat board plays engine seats 0 and 2, so seat two's tokens sit at
    // eight to eleven. The last of them is still on the board.
    const seats = [
      { seat: 1 as const, engineSeat: 0 },
      { seat: 2 as const, engineSeat: 2 },
    ];
    const tokens = [...Array.from({ length: 11 }, () => 57), 12];
    const state = { config: { tokensPerPlayer: 4 }, tokens } as unknown as Parameters<
      typeof resultProblem
    >[0]["state"];

    const problem = resultProblem({
      result: {
        finishingOrder: [1, 2],
        tokensHome: [4, 4],
        shots: 100,
      } as unknown as Parameters<typeof resultProblem>[0]["result"],
      state,
      seats,
    });

    expect(problem).toContain("seat 2 is recorded with 4 tokens home and has 3");
  });
});
