import {
  DEFAULT_CARROM_CONFIG,
  resolveConfig,
  type CarromConfig,
} from "../engines/carrom/config.js";
import { applyShot, createInitialState, type CarromShot } from "../engines/carrom/index.js";
import { verifyCommit } from "./fair-rng.js";
import { verifyLogChain, verifyResultSignature, type MatchLogEntry } from "./match-log.js";
import type { MatchRecord, MatchRepository } from "./match-repository.js";

/**
 * Independent verification of a finished match.
 *
 * Four things are checked, in order, and the first failure is reported with the
 * log sequence number it happened at:
 *
 * 1. The revealed seed hashes to the commitment published before play.
 * 2. The event log's hash chain is intact from that commitment to its head, and
 *    the head recorded on the match is that head.
 * 3. Every recorded shot, replayed through the engine from the seed, produces the
 *    same events the log recorded for it.
 * 4. The final position matches the signed result, and the result signature
 *    verifies with the server's signing secret.
 *
 * Nothing here trusts the room: it only uses the stored log, the stored result and
 * the engine.
 */

/** One named check and whether it passed. */
export interface VerifyCheck {
  readonly name:
    | "match_finished"
    | "seed_commit"
    | "hash_chain"
    | "shot_replay"
    | "final_result"
    | "result_signature";
  readonly ok: boolean;
  readonly detail?: string;
  /** The log entry the failure happened at, when there is one. */
  readonly seq?: number;
}

/** The report a verifier gets back. */
export interface VerifyReport {
  readonly ok: boolean;
  readonly matchId: string;
  readonly checks: readonly VerifyCheck[];
  /** The first failure, in one line, or null when everything passed. */
  readonly failure: string | null;
  readonly shots: number;
}

/** Options for a verification run. */
export interface VerifyOptions {
  /** Defaults to RESULT_SIGNING_SECRET from the environment. */
  readonly secret?: string;
  /** Overrides the rules stored on the match. */
  readonly config?: CarromConfig;
}

/** Checks a finished match. Never throws for a bad match: it reports. */
export async function verifyMatch(
  matchId: string,
  repository: MatchRepository,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const fail = (check: VerifyCheck): VerifyReport => ({
    ok: false,
    matchId,
    checks: [...checks, check],
    failure: check.detail ?? check.name,
    shots: 0,
  });

  const match = await repository.get(matchId);
  if (match === null) {
    return {
      ok: false,
      matchId,
      checks: [{ name: "match_finished", ok: false, detail: "no such match" }],
      failure: "no such match",
      shots: 0,
    };
  }

  // 1. Finished, with the seed revealed.
  if (match.status !== "finished" || match.seedReveal === null || match.result === null) {
    return fail({
      name: "match_finished",
      ok: false,
      detail: `match is ${match.status}, so there is nothing to verify yet`,
    });
  }
  if (match.seedCommit === null) {
    return fail({ name: "seed_commit", ok: false, detail: "the match has no seed commitment" });
  }
  checks.push({ name: "match_finished", ok: true });

  const seedReveal: string = match.seedReveal;
  const seedCommit: string = match.seedCommit;

  // 2. The seed matches its commitment.
  if (!verifyCommit(seedReveal, seedCommit)) {
    return fail({
      name: "seed_commit",
      ok: false,
      detail: "the revealed seed does not hash to the committed value",
    });
  }
  checks.push({ name: "seed_commit", ok: true });

  // 3. The hash chain, from the commitment to the head.
  const events = await repository.listEvents(matchId);
  const chain = verifyLogChain(events, seedCommit);
  if (!chain.ok) {
    return fail({
      name: "hash_chain",
      ok: false,
      detail: chain.reason,
      seq: chain.seq ?? undefined,
    });
  }
  if (match.logHeadHash !== null && match.logHeadHash !== chain.head) {
    return fail({
      name: "hash_chain",
      ok: false,
      detail: "the recorded log head is not the head of the stored chain",
      seq: chain.length,
    });
  }
  checks.push({ name: "hash_chain", ok: true });

  // 4. Replay every shot through the engine.
  const config = options.config ?? carromConfigFromMatch(match);
  let state = createInitialState(config, seedReveal);
  let shots = 0;
  // The events the engine produced for the shot just replayed: the log rows that
  // follow must be exactly these, in this order.
  let pendingEvents: Array<{ readonly type: string }> = [];

  const replayFailure = (entry: MatchLogEntry, detail: string): VerifyReport =>
    fail({ name: "shot_replay", ok: false, detail, seq: entry.seq });

  for (const entry of events) {
    if (entry.type === "match_start" || entry.type === "match_end") {
      continue;
    }
    if (entry.type === "turn_timeout" || entry.type === "player_forfeit") {
      pendingEvents = [];
      continue;
    }

    if (entry.type === "shot") {
      const shot = shotFromPayload(entry.payload);
      if (shot === null) {
        return replayFailure(entry, "the shot entry has no readable shot");
      }

      let applied: ReturnType<typeof applyShot>;
      try {
        applied = applyShot(state, shot, { config, recordFrames: false });
      } catch (error) {
        return replayFailure(
          entry,
          `the engine refused a recorded shot: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }

      const seat = entry.payload["seat"];
      const expectedColour = seat === 2 ? "black" : "white";
      if (entry.payload["colour"] !== undefined && entry.payload["colour"] !== expectedColour) {
        return replayFailure(entry, "the shot records a colour that does not match its seat");
      }

      state = applied.state;
      shots += 1;
      pendingEvents = [...applied.events];
      continue;
    }

    // Any other entry is an engine event, and must be the next one the replay
    // produced: this is what makes the log a record of the game and not a claim.
    const expected = pendingEvents.shift();
    if (expected === undefined || expected.type !== entry.type) {
      return replayFailure(
        entry,
        `the log records ${entry.type} where the replay produced ${expected?.type ?? "nothing"}`,
      );
    }
  }

  checks.push({ name: "shot_replay", ok: true });

  // 5. The final position matches the signed result.
  const finalScores = {
    white: state.players.white.score,
    black: state.players.black.score,
  };
  const result = match.result;

  if (finalScores.white !== result.scores.white || finalScores.black !== result.scores.black) {
    return fail({
      name: "final_result",
      ok: false,
      detail:
        `the replay ends ${finalScores.white}-${finalScores.black} but the result says ` +
        `${result.scores.white}-${result.scores.black}`,
    });
  }
  if (result.shots !== shots) {
    return fail({
      name: "final_result",
      ok: false,
      detail: `the result records ${result.shots} shots but the log holds ${shots}`,
    });
  }
  checks.push({ name: "final_result", ok: true });

  // 6. The signature over the result and the log head.
  if (match.resultSignature === null) {
    return fail({
      name: "result_signature",
      ok: false,
      detail: "the match has no result signature",
    });
  }
  const signed = verifyResultSignature(
    result,
    match.logHeadHash ?? chain.head,
    match.resultSignature,
    options.secret,
  );
  if (!signed) {
    return fail({
      name: "result_signature",
      ok: false,
      detail: "the result signature does not verify",
    });
  }
  checks.push({ name: "result_signature", ok: true });

  return { ok: true, matchId, checks, failure: null, shots };
}

/** Reads a shot back out of a log payload, refusing anything malformed. */
export function shotFromPayload(payload: Readonly<Record<string, unknown>>): CarromShot | null {
  const shot = payload["shot"];
  if (typeof shot !== "object" || shot === null) {
    return null;
  }

  const record = shot as Record<string, unknown>;
  const x = record["x"];
  const y = record["y"];
  const angle = record["angle"];
  const power = record["power"];

  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof angle !== "number" ||
    typeof power !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(angle) ||
    !Number.isFinite(power)
  ) {
    return null;
  }

  return { strikerPosition: { x, y }, angle, power };
}

/**
 * The rules a match was played under, read back from its stored config.
 *
 * Anything missing falls back to the engine defaults, so a match recorded before a
 * tunable existed still verifies.
 */
export function carromConfigFromMatch(match: MatchRecord): CarromConfig {
  const stored = match.config["carrom"];
  const overrides: Record<string, number> = {};

  if (typeof stored === "object" && stored !== null) {
    const record = stored as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_CARROM_CONFIG)) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        overrides[key] = value;
      }
    }
  }

  return resolveConfig(overrides as Partial<CarromConfig>);
}
