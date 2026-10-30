import { describe, expect, it } from "vitest";
import { commitOf, createMatchSeed } from "../../../src/lib/fair-rng.js";
import { InMemoryMatchRepository, type MatchRecord } from "../../../src/lib/match-repository.js";
import { MatchLogBuilder, type MatchLogEntry } from "../../../src/lib/match-log.js";
import { verifyMatch } from "../../../src/lib/match-verify.js";
import { logger } from "../../../src/lib/logger.js";
import { LudoMatchRunner, type LudoRunnerSeat } from "../../../src/rooms/ludo-match-runner.js";

/**
 * The verifier, against a real finished match and against four ways of bending one.
 *
 * Each failure is built with a *recomputed* chain, because a verifier that only
 * noticed a broken hash would be checking the wrong thing: the point is that a log
 * whose chain is perfect still fails when its contents are not what the seed says
 * happened.
 */

const quiet = logger.child({ test: "ludo-verify", level: "silent" });

interface Played {
  readonly repository: InMemoryMatchRepository;
  readonly matchId: string;
  readonly seed: string;
  readonly events: readonly MatchLogEntry[];
}

async function playMatch(): Promise<Played> {
  const repository = new InMemoryMatchRepository();
  const seed = createMatchSeed();
  const match = await repository.create({
    game: "ludo",
    seedCommit: commitOf(seed),
    seats: [
      { seat: 1, botLevel: "club", botPolicy: "cautious" },
      { seat: 2, botLevel: "club", botPolicy: "aggressive" },
      { seat: 3, botLevel: "club", botPolicy: "racer" },
      { seat: 4, botLevel: "club", botPolicy: "cautious" },
    ],
    config: { ludo: { players: 4 } },
  });

  const seats: LudoRunnerSeat[] = [...match.seats]
    .sort((left, right) => left.seat - right.seat)
    .map((seat) => ({
      seat: seat.seat,
      playerId: seat.playerId,
      displayName: seat.displayName,
      isBot: seat.isBot,
      botPolicy: seat.botPolicy,
      profileId: seat.profileId,
    }));

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
    config: { players: 4 },
    botDelayMs: { min: 0, max: 0 },
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
    logger: quiet,
    hooks: {
      onEnd: () => {
        done?.();
      },
    },
  });

  await runner.start();
  await ended;

  return { repository, matchId: match.id, seed, events: await repository.listEvents(match.id) };
}

/**
 * Rewrites a match so its log chain is *valid* but one entry says something else.
 *
 * The replacement runs through the same builder the room uses, so every hash on the
 * way to the head is consistent: this is what a server that lied about a roll would
 * have to produce.
 */
async function rewrite(
  played: Played,
  change: (entry: MatchLogEntry) => MatchLogEntry | null,
): Promise<void> {
  const seedCommit = commitOf(played.seed);
  const builder = new MatchLogBuilder(seedCommit);
  for (const entry of played.events) {
    const replacement = change(entry);
    builder.append(replacement?.type ?? entry.type, (replacement ?? entry).payload);
  }

  const rebuilt = builder.entries;
  const stored = await played.repository.get(played.matchId);
  if (stored === null) {
    throw new Error("the match vanished");
  }

  const patched: MatchRecord = { ...stored, logHeadHash: builder.head };
  const originalList = played.repository.listEvents.bind(played.repository);
  const originalGet = played.repository.get.bind(played.repository);

  played.repository.listEvents = async () => [...rebuilt];
  played.repository.get = async (matchId: string) =>
    matchId === played.matchId ? patched : originalGet(matchId);
  played.repository.listEvents = async (matchId: string) =>
    matchId === played.matchId ? [...rebuilt] : originalList(matchId);
}

describe("a finished ludo match", () => {
  it("verifies from the seed and the recorded moves alone", async () => {
    const played = await playMatch();
    const report = await verifyMatch(played.matchId, played.repository);

    expect(report.failure).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.shots).toBeGreaterThan(100);
    expect(report.checks.map((check) => check.name)).toEqual([
      "match_finished",
      "seed_commit",
      "hash_chain",
      "move_replay",
      "final_result",
      "result_signature",
    ]);
  }, 60_000);

  it("catches a roll that the seed did not produce", async () => {
    const played = await playMatch();
    await rewrite(played, (entry) => {
      if (entry.type !== "turn") {
        return null;
      }
      const roll = entry.payload["roll"];
      if (typeof roll !== "number") {
        return null;
      }
      return { ...entry, payload: { ...entry.payload, roll: roll === 6 ? 1 : 6 } };
    });

    const report = await verifyMatch(played.matchId, played.repository);
    expect(report.ok).toBe(false);
    expect(report.failure).toMatch(/not the roll the seed produced/u);
  }, 60_000);

  it("catches a token that could not have moved", async () => {
    const played = await playMatch();
    let changed = false;
    await rewrite(played, (entry) => {
      const token = entry.payload["token"];
      if (changed || entry.type !== "turn" || typeof token !== "number") {
        return null;
      }
      changed = true;
      const other = (token + 1) % 4;
      return { ...entry, payload: { ...entry.payload, token: other } };
    });
    expect(changed).toBe(true);

    const report = await verifyMatch(played.matchId, played.repository);
    expect(report.ok).toBe(false);
    expect(report.failure).toMatch(/no legal move|not where that move goes/u);
  }, 60_000);

  it("catches a finishing order the replay does not reach", async () => {
    const played = await playMatch();
    const stored = await played.repository.get(played.matchId);
    const result = stored?.result;
    expect(result).not.toBeNull();

    const originalGet = played.repository.get.bind(played.repository);
    played.repository.get = async (matchId: string) => {
      const match = await originalGet(matchId);
      if (match === null || match.result === null) {
        return match;
      }
      const order = [...(match.result.finishingOrder ?? [])].reverse();
      return { ...match, result: { ...match.result, finishingOrder: order } };
    };

    const report = await verifyMatch(played.matchId, played.repository);
    expect(report.ok).toBe(false);
    expect(report.failure).toMatch(/finishing order/u);
  }, 60_000);

  it("catches a signature that does not cover the log it claims", async () => {
    const played = await playMatch();
    const originalGet = played.repository.get.bind(played.repository);
    played.repository.get = async (matchId: string) => {
      const match = await originalGet(matchId);
      if (match === null || match.resultSignature === null) {
        return match;
      }
      return { ...match, resultSignature: "0".repeat(64) };
    };

    const report = await verifyMatch(played.matchId, played.repository);
    expect(report.ok).toBe(false);
    expect(report.failure).toMatch(/signature/u);
  }, 60_000);
});
