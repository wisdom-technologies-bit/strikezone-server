/**
 * What a Ludo match produced, in the shape the market catalogue settles against.
 *
 * Ludo has no board to measure, so every market is a question about the log: how
 * many rolls, who rolled the sixes, who captured whom and when, who got a token
 * out first, who got one home first, how many tokens each colour had home at
 * particular turns, and how the game ended. This file turns a finished match into
 * exactly those facts.
 *
 * Two sources feed the same builder, and that is the point of the builder: a real
 * match replays its log through the engine (`computeLudoStats`), and the odds
 * engine plays the fast simulator (`src/odds/ludo-sim.ts`), and both produce a
 * `LudoGameStats` field for field. A market that settles correctly on one settles
 * correctly on the other, and a test can compare them.
 *
 * Nothing here prices anything, and nothing here is randomised.
 */

import {
  LUDO_HOME,
  LUDO_YARD,
  applyMove,
  createInitialState,
  forfeitTurn,
  getLegalMoves,
  passTurn,
  progressOf,
  seatToPlay,
  shouldForfeitTripleSix,
  resolveLudoConfig,
  type LudoConfig,
  type LudoEvent,
  type LudoState,
} from "../engines/ludo/index.js";

/** One seat that captured another. */
export interface LudoCaptureRecord {
  /** The seat whose token did the capturing. */
  readonly seat: number;
  /** The seat whose token went back to its yard. */
  readonly victim: number;
  /** The turn, counting from one, in which it happened. */
  readonly turn: number;
}

/** A seat and the turn it happened on. */
export interface LudoTurnMark {
  readonly seat: number;
  readonly turn: number;
}

/** Everything a settlement rule may look at. */
export interface LudoGameStats {
  readonly game: "ludo";
  /** 2 or 4. */
  readonly players: 2 | 4;
  /** Seat numbers in play, in turn order. */
  readonly seats: readonly number[];
  /** True when a seat brought all its tokens home. */
  readonly finished: boolean;
  /**
   * True when the match stopped before anyone won: the turn cap, an abandoned
   * room or a forfeit. An abandoned match voids every bet.
   */
  readonly abandoned: boolean;

  /** Turns resolved: one die roll and whatever it led to. */
  readonly totalTurns: number;
  /**
   * Rounds played, where a round is one turn each of the seats in play.
   *
   * The game clock markets are written in rounds, not turns: a four player game
   * lasts about 420 turns, which is 105 rounds, and a line at 110 turns would be
   * one no game ever went under. `Math.ceil` because a game can end mid-round.
   */
  readonly totalRounds: number;
  /** Rolls drawn. Equal to `totalTurns` under these rules, kept apart for clarity. */
  readonly totalRolls: number;
  /** Turns each seat took, indexed by seat number, length 4. */
  readonly turnsBySeat: readonly number[];
  /** Rolls each seat drew, indexed by seat number, length 4. */
  readonly rollsBySeat: readonly number[];
  /** Sixes each seat rolled, indexed by seat number, length 4. */
  readonly sixesBySeat: readonly number[];
  /** Third-six forfeits each seat suffered, indexed by seat number, length 4. */
  readonly tripleSixesBySeat: readonly number[];

  /** Every capture, in order. */
  readonly captures: readonly LudoCaptureRecord[];
  /** Captures made by each seat, indexed by seat number, length 4. */
  readonly capturesBySeat: readonly number[];
  /** Times each seat lost a token to a capture, indexed by seat number, length 4. */
  readonly capturedTimesBySeat: readonly number[];

  /** The first token to leave its yard. */
  readonly firstOut: LudoTurnMark | null;
  /** The first token to reach home. */
  readonly firstHome: LudoTurnMark | null;
  /** The first six, and who rolled it. */
  readonly firstSix: LudoTurnMark | null;
  /** The first capture, on which turn and between whom. */
  readonly firstCapture: LudoCaptureRecord | null;
  /**
   * Rolls drawn before the first capture, counting the capture's own roll. Null
   * when nothing was ever captured.
   */
  readonly rollsBeforeFirstCapture: number | null;

  /**
   * Tokens home per seat after each turn: `homeBySeatAtTurn[t][seat]` is the count
   * after turn `t + 1`. Only collected when the caller asks for the trace, because
   * a million simulated games cannot keep a hundred small arrays each.
   */
  readonly homeBySeatAtTurn: readonly (readonly number[])[] | null;
  /** Tokens home per seat after round 20, or at the end if the game was shorter. */
  readonly homeAtRound20: readonly number[];
  /** Tokens home per seat after round 60, or at the end if the game was shorter. */
  readonly homeAtRound60: readonly number[];
  /**
   * For each seat: was it never strictly behind every other seat after round 20?
   * The fact behind Never Last, folded during the game so the trace is optional.
   */
  readonly neverFewestAfterRound20: readonly boolean[];
  /** The first seat to have two tokens home, and when. */
  readonly firstToTwoHome: LudoTurnMark | null;
  /** The first seat to have three tokens home, and when. */
  readonly firstToThreeHome: LudoTurnMark | null;

  /** Seats in the order they finished. */
  readonly finishingOrder: readonly number[];
  /** The winner, or null when nobody won. */
  readonly winnerSeat: number | null;
  /** Turns the winner had taken when it finished, or null. */
  readonly winnerTurns: number | null;
  /** True when the winner lost at least one token to a capture. */
  readonly winnerWasCaptured: boolean;
  /** Tokens home per seat at the end, indexed by seat number, length 4. */
  readonly finalHome: readonly number[];
  /** The last roll of the match, or null when no roll was made. */
  readonly lastRoll: number | null;
}

/** How many turns a simulated game is allowed before it counts as abandoned. */
export const LUDO_TURN_CAP = 600;

/** One turn as either source describes it. */
export interface LudoTurnRecord {
  readonly seat: number;
  readonly roll: number;
  /** Captures this turn made, as captor and victim seats. */
  readonly captures: readonly Omit<LudoCaptureRecord, "turn">[];
  /** True when this turn brought a token home. */
  readonly broughtHome: boolean;
  /** True when this turn left a token in the yard for the first time. */
  readonly firstOut: boolean;
  /** True when this turn was a third six and the turn was forfeited. */
  readonly forfeitedTripleSix: boolean;
  /** True when this turn finished the seat's fourth token. */
  readonly finishedSeat: boolean;
  /** Tokens home per seat after this turn, length 4. */
  readonly homeAfter: readonly number[];
}

/** Four zeroes, for "nothing happened to this seat". */
function zeroes(): number[] {
  return [0, 0, 0, 0];
}

/**
 * Builds a `LudoGameStats` from turns, whatever produced them.
 *
 * Both sources call `turn` once per resolved turn, in order, then `end` once. The
 * builder is deliberately the only place that decides what a fact means, so the
 * replay and the simulator cannot drift.
 */
export class LudoStatsBuilder {
  readonly #seats: readonly number[];
  readonly #trace: boolean;
  readonly #seatsPerRound: number;
  readonly #turns: LudoTurnRecord[] = [];
  readonly #finishingOrder: number[] = [];
  #homeAtRound20: readonly number[] | null = null;
  #homeAtRound60: readonly number[] | null = null;
  #firstToTwoHome: LudoTurnMark | null = null;
  #firstToThreeHome: LudoTurnMark | null = null;
  #neverFewest: boolean[] = [true, true, true, true];

  constructor(options: { readonly seats: readonly number[]; readonly trace?: boolean }) {
    this.#seats = [...options.seats];
    this.#trace = options.trace === true;
    this.#seatsPerRound = Math.max(1, this.#seats.length);
  }

  get turns(): number {
    return this.#turns.length;
  }

  /** Records one resolved turn. */
  turn(record: LudoTurnRecord): void {
    const turnNumber = this.#turns.length + 1;
    this.#turns.push(record);

    if (record.finishedSeat) {
      const last = this.#turns.length > 0 ? this.#turns[this.#turns.length - 1] : undefined;
      if (last !== undefined && !this.#finishingOrder.includes(record.seat)) {
        this.#finishingOrder.push(record.seat);
      }
    }

    const roundNumber = Math.ceil(turnNumber / this.#seatsPerRound);

    if (roundNumber === 20 && this.#homeAtRound20 === null) {
      this.#homeAtRound20 = [...record.homeAfter];
    }
    if (roundNumber === 60 && this.#homeAtRound60 === null) {
      this.#homeAtRound60 = [...record.homeAfter];
    }

    // 1UP and 2UP: the first seat to two and to three tokens home. Folded here
    // rather than read off the trace, so a million simulated games need no trace.
    for (const seat of this.#seats) {
      const home = record.homeAfter[seat] ?? 0;
      if (home >= 2) {
        this.#firstToTwoHome ??= { seat, turn: turnNumber };
      }
      if (home >= 3) {
        this.#firstToThreeHome ??= { seat, turn: turnNumber };
      }
    }

    if (roundNumber > 20) {
      const lowest = Math.min(...this.#seats.map((seat) => record.homeAfter[seat] ?? 0));
      for (const seat of this.#seats) {
        const home = record.homeAfter[seat] ?? 0;
        // Ties are not "behind": only a seat strictly below every other one is.
        const strictlyFewest =
          home === lowest &&
          this.#seats.every((other) => other === seat || (record.homeAfter[other] ?? 0) > home);
        if (strictlyFewest) {
          this.#neverFewest[seat] = false;
        }
      }
    }
  }

  /** The facts. Call once, after the last turn. */
  stats(options: {
    readonly winnerSeat: number | null;
    readonly lastRoll: number | null;
    readonly abandoned: boolean;
    /** Overrides the order observed turn by turn, for a game resumed mid-way. */
    readonly finishingOrder?: readonly number[];
  }): LudoGameStats {
    const turnsBySeat = zeroes();
    const rollsBySeat = zeroes();
    const sixesBySeat = zeroes();
    const tripleSixesBySeat = zeroes();
    const capturesBySeat = zeroes();
    const capturedTimesBySeat = zeroes();
    const captures: LudoCaptureRecord[] = [];
    const finalHome = zeroes();

    let firstOut: LudoTurnMark | null = null;
    let firstHome: LudoTurnMark | null = null;
    let firstSix: LudoTurnMark | null = null;
    let firstCapture: LudoCaptureRecord | null = null;
    let rollsBeforeFirstCapture: number | null = null;
    const trace: number[][] = [];

    this.#turns.forEach((record, index) => {
      const turnNumber = index + 1;
      turnsBySeat[record.seat] = (turnsBySeat[record.seat] ?? 0) + 1;
      rollsBySeat[record.seat] = (rollsBySeat[record.seat] ?? 0) + 1;

      if (record.roll === 6) {
        sixesBySeat[record.seat] = (sixesBySeat[record.seat] ?? 0) + 1;
        firstSix ??= { seat: record.seat, turn: turnNumber };
      }
      if (record.forfeitedTripleSix) {
        tripleSixesBySeat[record.seat] = (tripleSixesBySeat[record.seat] ?? 0) + 1;
      }
      if (record.firstOut) {
        firstOut ??= { seat: record.seat, turn: turnNumber };
      }
      if (record.broughtHome) {
        firstHome ??= { seat: record.seat, turn: turnNumber };
      }
      for (const capture of record.captures) {
        const found: LudoCaptureRecord = {
          seat: capture.seat,
          victim: capture.victim,
          turn: turnNumber,
        };
        captures.push(found);
        capturesBySeat[capture.seat] = (capturesBySeat[capture.seat] ?? 0) + 1;
        capturedTimesBySeat[capture.victim] = (capturedTimesBySeat[capture.victim] ?? 0) + 1;
        if (firstCapture === null) {
          firstCapture = found;
          rollsBeforeFirstCapture = turnNumber;
        }
      }
      if (this.#trace) {
        trace.push([...record.homeAfter]);
      }
      for (const seat of this.#seats) {
        finalHome[seat] = record.homeAfter[seat] ?? 0;
      }
    });

    const last = this.#turns.length > 0 ? this.#turns[this.#turns.length - 1] : undefined;
    const lastHome = last?.homeAfter ?? zeroes();

    const winnerSeat = options.winnerSeat;
    const winnerTurns = winnerSeat === null ? null : (turnsBySeat[winnerSeat] ?? null);

    return {
      game: "ludo",
      players: this.#seats.length === 2 ? 2 : 4,
      seats: [...this.#seats],
      finished: winnerSeat !== null,
      abandoned: options.abandoned,
      totalTurns: this.#turns.length,
      totalRounds: Math.ceil(this.#turns.length / this.#seatsPerRound),
      totalRolls: this.#turns.length,
      turnsBySeat,
      rollsBySeat,
      sixesBySeat,
      tripleSixesBySeat,
      captures,
      capturesBySeat,
      capturedTimesBySeat,
      firstOut,
      firstHome,
      firstSix,
      firstCapture,
      rollsBeforeFirstCapture,
      homeBySeatAtTurn: this.#trace ? trace : null,
      homeAtRound20: this.#homeAtRound20 === null ? [...lastHome] : [...this.#homeAtRound20],
      homeAtRound60: this.#homeAtRound60 === null ? [...lastHome] : [...this.#homeAtRound60],
      neverFewestAfterRound20: [...this.#neverFewest],
      firstToTwoHome: this.#firstToTwoHome,
      firstToThreeHome: this.#firstToThreeHome,
      finishingOrder:
        options.finishingOrder === undefined
          ? [...this.#finishingOrder]
          : [...options.finishingOrder],
      winnerSeat,
      winnerTurns,
      winnerWasCaptured: winnerSeat === null ? false : (capturedTimesBySeat[winnerSeat] ?? 0) > 0,
      finalHome,
      lastRoll: options.lastRoll,
    };
  }
}

/** What one turn of the real engine produced, as the builder wants it. */
function turnFromEvents(
  seat: number,
  roll: number,
  events: readonly LudoEvent[],
  next: LudoState,
): LudoTurnRecord {
  const captures = events
    .filter((event) => event.type === "capture" && event.captured !== undefined)
    .map((event) => ({ seat: event.seat, victim: event.captured?.seat ?? event.seat }));

  const homeAfter = zeroes();
  for (const player of next.seats) {
    let home = 0;
    for (let token = 0; token < next.config.tokensPerPlayer; token += 1) {
      if (progressOf(next, player, token) === LUDO_HOME) {
        home += 1;
      }
    }
    homeAfter[player] = home;
  }

  return {
    seat,
    roll,
    captures,
    broughtHome: events.some((event) => event.type === "token_home"),
    firstOut: events.some((event) => event.type === "token_out"),
    forfeitedTripleSix: events.some((event) => event.type === "triple_six_forfeit"),
    finishedSeat: events.some((event) => event.type === "player_finished"),
    homeAfter,
  };
}

/** A log entry, as the repository stores it. */
export interface LudoLogEntry {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const intOf = (payload: Readonly<Record<string, unknown>>, key: string): number | null => {
  const value = payload[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

/**
 * Rebuilds the facts from a match log by replaying it through the engine.
 *
 * This is the settlement path: exactly the same reading of the game the verifier
 * makes, so a match that verifies always produces the stats its bets settle on.
 * A log the engine refuses to replay throws rather than guessing.
 */
export function computeLudoStats(
  entries: readonly LudoLogEntry[],
  options: {
    readonly config?: Partial<LudoConfig>;
    readonly trace?: boolean;
    /** Set when the room reports the match ended without a winner. */
    readonly abandoned?: boolean;
  } = {},
): LudoGameStats {
  const config = resolveLudoConfig(options.config);
  let state = createInitialState(config);
  const builder = new LudoStatsBuilder({ seats: state.seats, trace: options.trace === true });
  let lastRoll: number | null = null;

  for (const entry of entries) {
    if (entry.type === "result") {
      continue;
    }
    if (entry.type !== "turn") {
      continue;
    }

    const seat = intOf(entry.payload, "seat");
    const roll = intOf(entry.payload, "roll");
    const action = entry.payload["action"];
    const token = intOf(entry.payload, "token");

    if (seat === null || roll === null) {
      throw new Error("a ludo log turn has no seat or roll");
    }
    if (state.status === "finished") {
      throw new Error("a ludo log has turns after the game ended");
    }

    const forfeited = shouldForfeitTripleSix(state, roll);
    const legal = forfeited ? [] : getLegalMoves(state, roll);
    let outcome;

    if (action === "move") {
      const move = legal.find((candidate) => candidate.token === token);
      if (move === undefined) {
        throw new Error(`token ${String(token)} has no legal move with a ${String(roll)}`);
      }
      outcome = applyMove(state, move);
    } else if (action === "pass") {
      outcome = passTurn(state, roll, "no_legal_move");
    } else if (action === "forfeit") {
      outcome = forfeitTurn(state, roll, "triple_six");
    } else {
      throw new Error(`a ludo log turn has an unknown action "${String(action)}"`);
    }

    builder.turn(turnFromEvents(seatToPlay(state), roll, outcome.events, outcome.state));
    state = outcome.state;
    lastRoll = roll;
  }

  const winnerSeat = state.status === "finished" ? (state.finishingOrder[0] ?? null) : null;

  return builder.stats({
    winnerSeat,
    lastRoll,
    abandoned: options.abandoned === true || (winnerSeat === null && options.abandoned !== false),
  });
}

/** True when a seat is in play. */
export function seatInPlay(stats: LudoGameStats, seat: number): boolean {
  return stats.seats.includes(seat);
}

/** The colour name of a seat, for market names. */
export const LUDO_SEAT_NAMES = Object.freeze([
  "Red",
  "Green",
  "Yellow",
  "Blue",
]) as readonly string[];

/** Progress a token has that is neither the yard nor home. */
export function isOnBoard(progress: number): boolean {
  return progress > LUDO_YARD && progress < LUDO_HOME;
}
