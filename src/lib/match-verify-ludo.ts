import {
  applyMove,
  createInitialState,
  createMatchDice,
  forfeitTurn,
  getLegalMoves,
  homeCount,
  passTurn,
  shouldForfeitTripleSix,
  type LudoConfig,
  type LudoState,
} from "../engines/ludo/index.js";
import { verifyCommit } from "./fair-rng.js";
import { verifyLogChain, verifyResultSignature, type MatchLogEntry } from "./match-log.js";
import type { MatchRecord, MatchRepository, SeatNumber } from "./match-repository.js";
import { ludoRulesForMatch } from "./ludo-config.js";
import type { VerifyCheck, VerifyReport } from "./match-verify.js";

/**
 * Independent verification of a finished Ludo match.
 *
 * The same four questions as Carrom, answered against a game whose randomness is
 * a die rather than a physics engine:
 *
 * 1. The revealed seed hashes to the commitment published before play.
 * 2. The log's hash chain runs unbroken from that commitment to the recorded head.
 * 3. Every turn replays: the recorded roll is the roll the seeded stream produced,
 *    the seat on turn is the seat the board says, and the move the log records is a
 *    legal move from the position the log has rebuilt.
 * 4. The finishing order the replay reaches is the finishing order in the signed
 *    result, and the signature verifies.
 *
 * Step 3 is the one that matters. A Ludo match is a roll and a choice, so a log
 * that names the roll and the token is a complete description of the game: replay
 * it and either the board ends where the result says it did or it does not.
 */

/** A log payload read as a finite integer, or null. */
function intOf(payload: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Checks a finished Ludo match. Never throws for a bad match: it reports. */
export async function verifyLudoMatch(
  match: MatchRecord,
  repository: MatchRepository,
  options: { readonly secret?: string; readonly config?: LudoConfig } = {},
): Promise<VerifyReport> {
  const matchId = match.id;
  const checks: VerifyCheck[] = [];
  const fail = (check: VerifyCheck): VerifyReport => ({
    ok: false,
    matchId,
    checks: [...checks, check],
    failure: check.detail ?? check.name,
    shots: 0,
  });

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

  if (!verifyCommit(seedReveal, seedCommit)) {
    return fail({
      name: "seed_commit",
      ok: false,
      detail: "the revealed seed does not hash to the committed value",
    });
  }
  checks.push({ name: "seed_commit", ok: true });

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

  // Replay the game from the seed and the recorded choices.
  const config = options.config ?? ludoRulesForMatch(match);
  const seats: SeatNumber[] = [...match.seats]
    .map((seat) => seat.seat)
    .sort((left, right) => left - right);

  let state: LudoState = {
    ...createInitialState({ ...config, players: 4 }),
    seats: seats.map((seat) => seat - 1),
  };
  const dice = createMatchDice(seedReveal, matchId, 0);
  let turns = 0;

  const replayFailure = (entry: MatchLogEntry, detail: string): VerifyReport =>
    fail({ name: "move_replay", ok: false, detail, seq: entry.seq });

  for (const entry of events) {
    if (entry.type === "result") {
      continue;
    }
    if (entry.type !== "turn") {
      return replayFailure(entry, `unexpected log entry "${entry.type}"`);
    }

    const seat = intOf(entry.payload, "seat");
    const roll = intOf(entry.payload, "roll");
    const action = entry.payload["action"];
    const token = intOf(entry.payload, "token");

    if (seat === null || roll === null) {
      return replayFailure(entry, "the turn entry has no seat or roll");
    }
    if (roll < 1 || roll > config.diceSides) {
      return replayFailure(entry, `a roll of ${roll} is not on this die`);
    }

    const expectedRoll = dice.roll(config.diceSides);
    if (roll !== expectedRoll) {
      return replayFailure(
        entry,
        `the recorded roll ${roll} is not the roll the seed produced (${expectedRoll})`,
      );
    }

    const seatOnTurn = ((state.seats[state.turn] ?? 0) + 1) as number;
    if (seat !== seatOnTurn) {
      return replayFailure(entry, `the log has seat ${seat} to play, the board has ${seatOnTurn}`);
    }

    const forfeited = shouldForfeitTripleSix(state, roll);
    const legal = forfeited ? [] : getLegalMoves(state, roll);

    if (action === "move") {
      const move = legal.find((candidate) => candidate.token === token);
      if (move === undefined) {
        return replayFailure(
          entry,
          `token ${String(token)} has no legal move with a ${roll} from this position`,
        );
      }
      if (intOf(entry.payload, "from") !== move.from || intOf(entry.payload, "to") !== move.to) {
        return replayFailure(entry, "the recorded from/to is not where that move goes");
      }
      if (intOf(entry.payload, "captures") !== move.captures.length) {
        return replayFailure(entry, "the recorded captures do not match the move");
      }
      state = applyMove(state, move).state;
    } else if (action === "pass") {
      if (forfeited || legal.length > 0) {
        return replayFailure(entry, "the log passes a turn that had a legal move");
      }
      state = passTurn(state, roll, "no_legal_move").state;
    } else if (action === "forfeit") {
      if (!forfeited) {
        return replayFailure(entry, "the log forfeits a turn that was not a third six");
      }
      state = forfeitTurn(state, roll, "triple_six").state;
    } else {
      return replayFailure(entry, `the turn records an unknown action "${String(action)}"`);
    }

    turns += 1;
  }

  if (state.status !== "finished") {
    return fail({
      name: "move_replay",
      ok: false,
      detail: `the replayed match is ${state.status}, but the result says it finished`,
    });
  }
  checks.push({ name: "move_replay", ok: true });

  // The replayed board against the signed result.
  const replayedOrder = state.finishingOrder.map((seat) => (seat + 1) as SeatNumber);
  const recordedOrder = match.result.finishingOrder ?? [];
  if (recordedOrder.join(",") !== replayedOrder.join(",")) {
    return fail({
      name: "final_result",
      ok: false,
      detail: `the replayed finishing order (${replayedOrder.join(", ")}) is not the recorded one (${recordedOrder.join(", ")})`,
    });
  }

  const recordedWinner = match.result.winnerSeat;
  if (recordedWinner !== (replayedOrder[0] ?? null)) {
    return fail({
      name: "final_result",
      ok: false,
      detail: `the result names seat ${String(recordedWinner)} as winner, the replay says ${String(replayedOrder[0])}`,
    });
  }

  const recordedHome = match.result.tokensHome;
  if (recordedHome !== undefined) {
    for (const seat of seats) {
      const replayed = homeCount(state, seat - 1);
      if (recordedHome[seat - 1] !== replayed) {
        return fail({
          name: "final_result",
          ok: false,
          detail: `seat ${seat} has ${replayed} tokens home in the replay, ${String(recordedHome[seat - 1])} in the result`,
        });
      }
    }
  }

  const recordedMoves = match.result.shots;
  if (recordedMoves !== turns) {
    return fail({
      name: "final_result",
      ok: false,
      detail: `the result counts ${recordedMoves} moves, the log has ${turns}`,
    });
  }
  checks.push({ name: "final_result", ok: true });

  if (
    match.resultSignature === null ||
    match.logHeadHash === null ||
    !verifyResultSignature(match.result, match.logHeadHash, match.resultSignature, options.secret)
  ) {
    return fail({
      name: "result_signature",
      ok: false,
      detail: "the result signature does not verify against the log head",
    });
  }
  checks.push({ name: "result_signature", ok: true });

  return { ok: true, matchId, checks, failure: null, shots: turns };
}
