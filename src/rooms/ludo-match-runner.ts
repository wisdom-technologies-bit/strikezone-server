/**
 * The Ludo referee driver.
 *
 * The room is a transport shell; this is the part that decides when to roll, when
 * to wait for a player, when a bot picks a token and when the clock has run out.
 * It is written to be driven without a network, so the room tests and the demo can
 * play a whole four-bot game in milliseconds.
 *
 * The order of a turn, from the brief:
 *
 * 1. the server rolls and broadcasts the roll;
 * 2. the player picks a token with `{ type: "move", tokenIndex }`;
 * 3. the server validates the choice against `getLegalMoves` and applies it;
 * 4. `move.received` goes out before the next roll is broadcast.
 *
 * Three rules hang off that order: a turn with exactly one legal move plays it
 * after one second; a human who has not chosen within twenty seconds gets the
 * policy's move; three timeouts forfeit the match.
 */

import {
  applyMove,
  forfeitTurn,
  getLegalMoves,
  passTurn,
  shouldForfeitTripleSix,
  chooserFor,
  createMatchDice,
  createInitialState,
  homeCount,
  resolveLudoConfig,
  type DieSource,
  type LudoBotId,
  type LudoChooser,
  type LudoConfig,
  type LudoEvent,
  type LudoMove,
  type LudoState,
} from "../engines/ludo/index.js";
import { publish } from "../lib/events.js";
import { MatchLogBuilder, signResult, type MatchLogEntry } from "../lib/match-log.js";
import type {
  MatchRecord,
  MatchRepository,
  MatchResult,
  SeatNumber,
} from "../lib/match-repository.js";
import type { Logger } from "pino";

/** How long a player has to choose, from the brief. */
export const LUDO_MOVE_SECONDS = 20;

/** How long the server waits before playing the only legal move. */
export const LUDO_SINGLE_MOVE_DELAY_MS = 1_000;

/** How many timeouts forfeit a match. */
export const LUDO_TIMEOUTS_TO_FORFEIT = 3;

/** The policy a seat plays when it is a bot, or when a human times out. */
const DEFAULT_POLICY: LudoBotId = "cautious";

/** One seat as the runner needs it. */
export interface LudoRunnerSeat {
  readonly seat: SeatNumber;
  readonly playerId: string;
  readonly displayName: string;
  readonly isBot: boolean;
  /** The published policy id, or null for a human. */
  readonly botPolicy: string | null;
  readonly profileId: string | null;
}

/** A timer facility, injected so a test can run the clock instantly. */
export type Scheduler = (delayMs: number, run: () => void) => () => void;

/** What the runner tells its room. */
export interface LudoRunnerHooks {
  /** A roll is on the table and a seat has to choose. */
  onRoll?: (info: LudoRollInfo) => void;
  /** A turn resolved: the move (or pass) and its events. */
  onTurn?: (info: LudoTurnInfo) => void;
  /** The game is over and the result is written. */
  onEnd?: (info: { readonly result: MatchResult; readonly state: LudoState }) => void;
  /**
   * The log lost an entry, so the match cannot be signed or settled. The room
   * closes it as abandoned instead of letting a result reach the books.
   */
  onAbandoned?: (info: { readonly reason: string }) => void;
}

/** What the room broadcasts when the die is rolled. */
export interface LudoRollInfo {
  readonly seat: SeatNumber;
  readonly roll: number;
  readonly moves: readonly LudoMove[];
  /** Seconds the seat has to choose. */
  readonly moveSeconds: number;
  readonly forfeited: boolean;
}

/** What happened in one resolved turn. */
export interface LudoTurnInfo {
  readonly seat: SeatNumber;
  readonly roll: number;
  readonly move: LudoMove | null;
  readonly events: readonly LudoEvent[];
  readonly state: LudoState;
  /** The move number in this match, counting from one. */
  readonly moveNumber: number;
}

/** Everything the runner needs from the outside. */
export interface LudoMatchRunnerDeps {
  readonly matchId: string;
  readonly seed: string;
  readonly seedCommit: string;
  readonly seats: readonly LudoRunnerSeat[];
  readonly repository: MatchRepository;
  readonly config: Partial<LudoConfig>;
  readonly botDelayMs: { readonly min: number; readonly max: number };
  readonly schedule: Scheduler;
  readonly logger: Logger;
  readonly hooks?: LudoRunnerHooks;
  /** A source of randomness, for a test. Defaults to the match's own stream. */
  readonly dice?: DieSource;
  /** Random numbers for bot delays, drawn from the match stream. */
  readonly jitter?: () => number;
  /** How long the only legal move waits before it plays itself. */
  readonly singleMoveDelayMs?: number;
}

/** Builds runner seats from a stored match, keeping seats 1 to 4. */
export function ludoRunnerSeatsFromMatch(match: MatchRecord): LudoRunnerSeat[] {
  return [...match.seats]
    .sort((left, right) => left.seat - right.seat)
    .map((seat) => ({
      seat: seat.seat,
      playerId: seat.playerId,
      displayName: seat.displayName,
      isBot: seat.isBot,
      botPolicy: seat.botPolicy,
      profileId: seat.profileId,
    }));
}

/** The choice a policy makes for a seat. */
function policyFor(seat: LudoRunnerSeat): LudoChooser {
  const id = seat.botPolicy;
  const known: readonly LudoBotId[] = ["cautious", "aggressive", "racer"];
  const policy = known.find((candidate) => candidate === id) ?? DEFAULT_POLICY;
  return chooserFor(policy);
}

export class LudoMatchRunner {
  readonly #deps: LudoMatchRunnerDeps;
  readonly #config: LudoConfig;
  readonly #dice: DieSource;
  readonly #log: MatchLogBuilder;
  readonly #seatsByNumber = new Map<number, LudoRunnerSeat>();
  readonly #timeouts = new Map<number, number>();

  #state: LudoState;
  #moveNumber = 0;
  #pending: {
    readonly seat: SeatNumber;
    readonly roll: number;
    readonly moves: readonly LudoMove[];
  } | null = null;
  #cancel: (() => void) | null = null;
  #stopped = false;
  #ended = false;
  /**
   * Writes go out one after another.
   *
   * The log has to reach the database in sequence order, and a turn is appended as
   * it happens so a crash mid-match leaves a verifiable log. Chaining the writes
   * keeps that promise without making a bot game wait for the network on every
   * roll.
   */
  #writes: Promise<void> = Promise.resolve();

  constructor(deps: LudoMatchRunnerDeps) {
    this.#deps = deps;
    this.#config = resolveLudoConfig({ players: 4, ...deps.config });

    const seats = [...deps.seats].sort((left, right) => left.seat - right.seat);
    for (const seat of seats) {
      this.#seatsByNumber.set(seat.seat, seat);
    }

    this.#state = createInitialState({ ...this.#config, players: 4 });
    // Seats are numbered from one in the database and from zero in the engine, so
    // the board is built from the seat table rather than from 0 to 3.
    this.#state = {
      ...this.#state,
      seats: seats.map((seat) => seat.seat - 1),
    };
    this.#dice = deps.dice ?? createMatchDice(deps.seed, deps.matchId, 0);
    this.#log = new MatchLogBuilder(deps.seedCommit);
  }

  /** The board, as plain JSON. */
  get state(): LudoState {
    return this.#state;
  }

  /** The seat number whose turn it is. */
  get seatToPlay(): SeatNumber {
    return ((this.#state.seats[this.#state.turn] ?? 0) + 1) as SeatNumber;
  }

  /** How many turns have resolved. */
  get moveNumber(): number {
    return this.#moveNumber;
  }

  /** The pending roll, while a seat is choosing. */
  get pending(): {
    readonly seat: SeatNumber;
    readonly roll: number;
    readonly moves: readonly LudoMove[];
  } | null {
    return this.#pending;
  }

  /** How many times a seat has run the clock out. */
  timeouts(seat: SeatNumber): number {
    return this.#timeouts.get(seat) ?? 0;
  }

  /** Starts the match: marks it live and rolls for the first seat. */
  async start(): Promise<void> {
    await this.#deps.repository.markLive(this.#deps.matchId, {
      seedCommit: this.#deps.seedCommit,
      startedAt: new Date().toISOString(),
    });

    // The joining rule is about humans: a bot is always present. Recording the
    // seats that have no human behind them keeps the walkover test honest.
    for (const seat of this.#deps.seats) {
      if (seat.isBot) {
        await this.#deps.repository.recordJoin(
          this.#deps.matchId,
          seat.seat,
          new Date().toISOString(),
        );
      }
    }

    this.#deps.logger.info(
      { matchId: this.#deps.matchId, players: this.#config.players },
      "ludo match started",
    );
    this.#beginTurn();
  }

  /** Stops the runner: no more timers fire. */
  stop(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
  }

  /**
   * A player chose a token.
   *
   * Returns why it was refused, or null when it was applied. The room sends the
   * refusal back to the client; nothing is applied on a refusal, so a client can
   * retry inside its own clock.
   */
  submitMove(seat: SeatNumber, tokenIndex: number): string | null {
    const pending = this.#pending;
    if (pending === null) {
      return "not_your_turn";
    }
    if (pending.seat !== seat) {
      return "not_your_turn";
    }

    const move = pending.moves.find((candidate) => candidate.token === tokenIndex);
    if (move === undefined) {
      return "illegal_move";
    }

    this.#cancel?.();
    this.#cancel = null;
    this.#resolve(move);
    return null;
  }

  #beginTurn(): void {
    if (this.#stopped || this.#ended || this.#state.status === "finished") {
      return;
    }

    const seat = this.seatToPlay;
    const roll = this.#dice.roll(this.#config.diceSides);
    const forfeited = shouldForfeitTripleSix(this.#state, roll);
    const moves = forfeited ? [] : getLegalMoves(this.#state, roll);

    this.#pending = { seat, roll, moves };
    this.#deps.hooks?.onRoll?.({
      seat,
      roll,
      moves,
      moveSeconds: this.#config.moveSeconds,
      forfeited,
    });

    if (forfeited || moves.length === 0) {
      // Nothing to choose: resolve on the next tick so a long run of passes
      // cannot grow the stack.
      this.#schedule(0, () => {
        this.#resolve(null);
      });
      return;
    }

    const runnerSeat = this.#seatsByNumber.get(seat);

    if (runnerSeat !== undefined && runnerSeat.isBot) {
      // A bot thinks for the same one to three seconds whatever the choice: the
      // single move rule below is for a person deciding, and a bot that paused a
      // second on every forced move would make a four bot game unwatchable.
      const chooser = policyFor(runnerSeat);
      this.#schedule(this.#botDelay(), () => {
        const chosen = chooser(this.#state, roll, moves);
        this.#resolve(chosen);
      });
      return;
    }

    if (moves.length === 1) {
      // The brief's rule: the only legal move is played for the player, after a beat.
      const only = moves[0];
      this.#schedule(this.#deps.singleMoveDelayMs ?? LUDO_SINGLE_MOVE_DELAY_MS, () => {
        this.#resolve(only ?? null);
      });
      return;
    }

    this.#schedule(this.#config.moveSeconds * 1_000, () => {
      this.#onTimeout(seat, roll, moves);
    });
  }

  /** A human ran the clock out: the policy plays, and the third one forfeits. */
  #onTimeout(seat: SeatNumber, roll: number, moves: readonly LudoMove[]): void {
    if (this.#stopped || this.#ended) {
      return;
    }

    const count = (this.#timeouts.get(seat) ?? 0) + 1;
    this.#timeouts.set(seat, count);

    this.#deps.logger.warn({ matchId: this.#deps.matchId, seat, count }, "ludo move timed out");

    void publish("match.shot", {
      matchId: this.#deps.matchId,
      game: "ludo",
      seat,
      shotNumber: this.#moveNumber + 1,
    });

    if (count >= this.#config.timeoutsToForfeit) {
      void this.#endByTimeout(seat);
      return;
    }

    const runnerSeat = this.#seatsByNumber.get(seat);
    const chooser = runnerSeat === undefined ? chooserFor(DEFAULT_POLICY) : policyFor(runnerSeat);
    const chosen = chooser(this.#state, roll, moves);
    this.#resolve(chosen);
  }

  /** Three timeouts: this seat is out, and the match is settled by the board. */
  async #endByTimeout(seat: SeatNumber): Promise<void> {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#cancel?.();

    const remaining = [...this.#deps.seats]
      .map((candidate) => candidate.seat)
      .filter((candidate) => candidate !== seat)
      .sort((left, right) => {
        const leftHome = homeCount(this.#state, left - 1);
        const rightHome = homeCount(this.#state, right - 1);
        if (leftHome !== rightHome) {
          return rightHome - leftHome;
        }
        return this.#progressOf(left) - this.#progressOf(right);
      });

    const finishingOrder: SeatNumber[] = [...remaining, seat];
    const result: MatchResult = {
      winnerSeat: remaining[0] ?? seat,
      winnerColour: "tie",
      scores: { white: 0, black: 0 },
      boards: 0,
      shots: this.#moveNumber,
      reason: "timeout",
      seedDraws: this.#dice.rolls,
      finishingOrder,
      tokensHome: this.#tokensHome(),
    };

    const entry = this.#log.append("timeout_forfeit", { seat, place: finishingOrder.length });
    await this.#persist(result, [entry]);

    this.#deps.hooks?.onEnd?.({
      result,
      state: { ...this.#state, status: "finished", finishingOrder },
    });
  }

  /** Total progress of a seat, for ordering seats when a match ends on the clock. */
  #progressOf(seat: SeatNumber): number {
    const base = (seat - 1) * this.#state.config.tokensPerPlayer;
    let total = 0;
    for (let token = 0; token < this.#state.config.tokensPerPlayer; token += 1) {
      total += this.#state.tokens[base + token] ?? 0;
    }
    return total;
  }

  #tokensHome(): readonly number[] {
    return this.#deps.seats
      .slice()
      .sort((left, right) => left.seat - right.seat)
      .map((seat) => homeCount(this.#state, seat.seat - 1));
  }

  #botDelay(): number {
    const jitter = this.#deps.jitter?.() ?? 0.5;
    const span = this.#deps.botDelayMs.max - this.#deps.botDelayMs.min;
    return Math.round(this.#deps.botDelayMs.min + span * Math.min(0.999, Math.max(0, jitter)));
  }

  #schedule(delayMs: number, run: () => void): void {
    this.#cancel?.();
    this.#cancel = this.#deps.schedule(delayMs, () => {
      this.#cancel = null;
      run();
    });
  }

  /** Applies the chosen move, or resolves the turn without one. */
  #resolve(move: LudoMove | null): void {
    if (this.#stopped || this.#ended) {
      return;
    }

    const pending = this.#pending;
    if (pending === null) {
      return;
    }
    this.#pending = null;

    const forfeited = shouldForfeitTripleSix(this.#state, pending.roll);
    const outcome =
      move !== null
        ? applyMove(this.#state, move)
        : forfeited
          ? forfeitTurn(this.#state, pending.roll, "triple_six")
          : passTurn(this.#state, pending.roll, "no_legal_move");

    this.#state = outcome.state;
    this.#moveNumber += 1;

    const action = move === null ? (forfeited ? "forfeit" : "pass") : "move";
    const entry: MatchLogEntry = this.#log.append("turn", {
      seat: pending.seat,
      roll: pending.roll,
      action,
      token: move?.token ?? null,
      from: move?.from ?? null,
      to: move?.to ?? null,
      captures: move?.captures.length ?? 0,
    });

    // The event goes out before the next roll is broadcast, exactly like
    // shot.received: whoever is pricing this match learns of the move from the
    // board, not from a stream that has already moved on.
    void publish("move.received", {
      matchId: this.#deps.matchId,
      game: "ludo",
      seat: pending.seat,
      moveNumber: this.#moveNumber,
      token: move?.token ?? null,
      roll: pending.roll,
    });
    void publish("match.shot", {
      matchId: this.#deps.matchId,
      game: "ludo",
      seat: pending.seat,
      shotNumber: this.#moveNumber,
    });

    this.#deps.hooks?.onTurn?.({
      seat: pending.seat,
      roll: pending.roll,
      move,
      events: outcome.events,
      state: this.#state,
      moveNumber: this.#moveNumber,
    });

    // The log entry is written as it happens, so a crash mid-match leaves a log
    // that still verifies up to its head.
    this.#append([entry]);

    if (this.#state.status === "finished") {
      void this.#finish();
      return;
    }

    this.#beginTurn();
  }

  /** Writes the signed result and tells the room. */
  async #finish(): Promise<void> {
    if (this.#ended) {
      return;
    }
    this.#ended = true;

    // The queued writes are flushed first: a result is signed over the log's head,
    // and a head read before the last turns land would sign a log that does not
    // contain them.
    await this.#writes;

    if (this.#appendFailed) {
      this.#deps.logger.error(
        { matchId: this.#deps.matchId },
        "the match log is incomplete: abandoning the match rather than signing it",
      );
      this.#deps.hooks?.onAbandoned?.({ reason: "match log incomplete" });
      return;
    }
    this.#cancel?.();
    this.#cancel = null;

    const finishingOrder = this.#state.finishingOrder.map((seat) => (seat + 1) as SeatNumber);
    const result: MatchResult = {
      winnerSeat: finishingOrder[0] ?? null,
      winnerColour: "tie",
      scores: { white: 0, black: 0 },
      boards: 0,
      shots: this.#moveNumber,
      reason: "finished",
      seedDraws: this.#dice.rolls,
      finishingOrder,
      tokensHome: this.#tokensHome(),
    };

    const entry = this.#log.append("result", {
      finishingOrder: [...finishingOrder],
      moves: this.#moveNumber,
    });

    await this.#persist(result, [entry]);
    this.#deps.logger.info(
      {
        matchId: this.#deps.matchId,
        moves: this.#moveNumber,
        finishingOrder: [...finishingOrder],
      },
      "ludo match finished",
    );

    this.#deps.hooks?.onEnd?.({ result, state: this.#state });
  }

  /**
   * Set when an append fails.
   *
   * A turn that never reached the log leaves a hole, and a result signed over a
   * log with a hole is a result that will not verify: the replay sees a board that
   * disagrees with the recorded result, and the reason is invisible from there.
   * So the failure is remembered, and a match whose log is incomplete is abandoned
   * rather than finished.
   */
  #appendFailed = false;

  /** Queues a batch of log entries, in order. */
  #append(entries: readonly MatchLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return this.#writes;
    }
    this.#writes = this.#writes
      .then(() => this.#deps.repository.appendEvents(this.#deps.matchId, [...entries]))
      .catch((error: unknown) => {
        this.#appendFailed = true;
        this.#deps.logger.error(
          { err: error, matchId: this.#deps.matchId },
          "could not append to the match log",
        );
      });
    return this.#writes;
  }

  /** Reveals the seed, signs the result and writes both. */
  async #persist(result: MatchResult, finalEntries: readonly MatchLogEntry[]): Promise<void> {
    const logHeadHash = this.#log.head;
    const resultSignature = signResult(result, logHeadHash);

    await this.#append(finalEntries);
    await this.#deps.repository.finish(this.#deps.matchId, {
      seedReveal: this.#deps.seed,
      result,
      resultSignature,
      logHeadHash,
      endedAt: new Date().toISOString(),
    });
  }
}
