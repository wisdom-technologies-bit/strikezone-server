/**
 * The simulator: the same rules, without allocation.
 *
 * `npm run ludo:bench` prints its rate, and the odds engine plays millions of
 * games through it, so this file exists to remove every allocation from the hot
 * path while staying byte-for-byte the same game as `rules.ts`:
 *
 * - the board is one `Uint8Array`, progress plus one, so `0` is the yard and the
 *   values run to `57 + 1`;
 * - occupancy is one pass per turn into a reused `Uint8Array`, so landing checks
 *   are O(1);
 * - the three policies are scored inline, with the same constants and the same
 *   tie-break as `bots.ts`, because the parity test compares this simulator with
 *   the referee over whole games and the two must agree exactly.
 *
 * Nothing here mutates a caller's data and nothing escapes: `snapshot()` is the
 * only way out, and it builds the plain JSON state the room broadcasts.
 *
 * Informed by reading public Ludo rule sets. This code is original.
 */

import {
  LUDO_GEOMETRY,
  resolveLudoConfig,
  seatsOf,
  startCellOf,
  type LudoConfig,
} from "./config.js";
import { LUDO_HOME, LUDO_YARD, type LudoState } from "./types.js";
import type { LudoBotId } from "./bot-config.js";

/** Distance behind a token an opponent can reach from. */
const DANGER_RANGE = 6;

/** The yard stored as zero, so the array never needs a signed type. */
const YARD_STORED = 0;

/** One turn's outcome, as flags. No arrays, no objects, nothing to collect. */
export interface SimTurnResult {
  /** Tokens captured this turn. */
  readonly captures: number;
  /**
   * Which seats lost a token this turn, as a bitmask: bit `n` is seat `n`.
   * The odds engine needs to know who captured whom, and a mask costs nothing.
   */
  readonly capturedSeatMask: number;
  /** True when the moved token left its yard on this turn. */
  readonly entered: boolean;
  /** True when a token reached home. */
  readonly broughtHome: boolean;
  /** True when the seat rolled a third six and lost the turn. */
  readonly forfeited: boolean;
  /** True when the roll had no legal move. */
  readonly passed: boolean;
}

/**
 * A game in progress, in typed arrays.
 *
 * One instance plays as many games as you like: `reset()` returns it to the start
 * without allocating, which is what the odds engine does between simulations.
 */
export class LudoSimulator {
  readonly #config: LudoConfig;
  readonly #policy: LudoBotId;
  readonly #seats: readonly number[];
  readonly #starts: Uint8Array;
  readonly #safe: Uint8Array;
  /** Progress plus one per token, flat by seat. */
  readonly #progress: Uint8Array;
  /** Tokens standing on each ring cell, per seat, reused every turn. */
  readonly #occupancy: Uint8Array;
  /** The tokens standing on each ring cell of each seat, for captures. */
  readonly #occupantToken: Uint8Array;
  readonly #finishingOrder: Uint8Array;

  #turn = 0;
  #sixes = 0;
  #rolls = 0;
  #finishedSeats = 0;
  #status: "playing" | "finished" = "playing";
  /** Which seats lost a token in the capture just applied, as a bitmask. */
  #lastCaptureMask = 0;

  constructor(options: { readonly config?: Partial<LudoConfig>; readonly policy: LudoBotId }) {
    this.#config = resolveLudoConfig(options.config);
    this.#policy = options.policy;
    this.#seats = seatsOf(this.#config);

    const starts = new Uint8Array(LUDO_GEOMETRY.ringCells);
    for (const seat of this.#seats) {
      starts[seat] = startCellOf(seat);
    }
    this.#starts = starts;

    const safe = new Uint8Array(LUDO_GEOMETRY.ringCells);
    for (const cell of LUDO_GEOMETRY.safeCells) {
      safe[cell] = 1;
    }
    this.#safe = safe;

    const tokenSlots = 4 * this.#config.tokensPerPlayer;
    this.#progress = new Uint8Array(tokenSlots);
    // 4 seats x 52 cells: one count and one token number per seat and cell.
    this.#occupancy = new Uint8Array(4 * LUDO_GEOMETRY.ringCells);
    this.#occupantToken = new Uint8Array(4 * LUDO_GEOMETRY.ringCells);
    this.#finishingOrder = new Uint8Array(4);
  }

  /** Back to the start of a fresh game, without allocating. */
  reset(): void {
    this.#progress.fill(YARD_STORED);
    this.#turn = 0;
    this.#sixes = 0;
    this.#rolls = 0;
    this.#finishedSeats = 0;
    this.#status = "playing";
    this.#finishingOrder.fill(0);
  }

  /**
   * Puts the simulator on an existing position.
   *
   * The live reprice happens mid-game, so it has to start where the board is,
   * not from the yard. The snapshot it takes is the room's own `LudoState`, so
   * nothing here needs a second definition of the game.
   */
  loadState(state: LudoState): void {
    if (state.config.players !== this.#config.players) {
      throw new RangeError("the position was played with a different number of players");
    }

    this.#progress.fill(YARD_STORED);
    for (let index = 0; index < this.#progress.length && index < state.tokens.length; index += 1) {
      this.#progress[index] = (state.tokens[index] ?? LUDO_YARD) + 1;
    }

    this.#turn = state.turn;
    this.#sixes = state.sixes;
    this.#rolls = state.rolls;
    this.#finishingOrder.fill(0);
    this.#finishedSeats = 0;
    for (const seat of state.finishingOrder) {
      if (this.#finishedSeats < this.#finishingOrder.length) {
        this.#finishingOrder[this.#finishedSeats] = seat;
        this.#finishedSeats += 1;
      }
    }
    this.#status = state.status;
  }

  get status(): "playing" | "finished" {
    return this.#status;
  }

  /** Tokens of this seat that are home. */
  homeCountOf(seat: number): number {
    return this.#homeCount(seat);
  }

  get rolls(): number {
    return this.#rolls;
  }

  get turnIndex(): number {
    return this.#turn;
  }

  /** The seat to play. */
  get seatToPlay(): number {
    return this.#seats[this.#turn] ?? 0;
  }

  /** The finishing order so far, seat numbers, in order. */
  finishingOrder(): readonly number[] {
    return [...this.#finishingOrder.subarray(0, this.#finishedSeats)];
  }

  /** One token's progress, `-1` for the yard. */
  progressOf(seat: number, token: number): number {
    return (this.#progress[seat * this.#config.tokensPerPlayer + token] ?? 1) - 1;
  }

  /** The plain JSON state, for the room, the log and the parity test. */
  snapshot(): LudoState {
    const tokens: number[] = [];
    for (let index = 0; index < this.#progress.length; index += 1) {
      tokens.push((this.#progress[index] ?? 1) - 1);
    }

    return {
      config: this.#config,
      seats: this.#seats,
      tokens,
      turn: this.#turn,
      sixes: this.#sixes,
      rolls: this.#rolls,
      finishingOrder: this.finishingOrder(),
      status: this.#status,
    };
  }

  /** Counts the tokens standing on each ring cell. One pass, reused buffers. */
  #countOccupancy(): void {
    this.#occupancy.fill(0);
    const perPlayer = this.#config.tokensPerPlayer;
    const ringSteps = LUDO_GEOMETRY.ringSteps;

    for (let seatIndex = 0; seatIndex < this.#seats.length; seatIndex += 1) {
      const seat = this.#seats[seatIndex] ?? 0;
      const start = this.#starts[seat] ?? 0;
      for (let token = 0; token < perPlayer; token += 1) {
        const progress = (this.#progress[seat * perPlayer + token] ?? 1) - 1;
        if (progress < 0 || progress > ringSteps - 1) {
          continue;
        }
        const cell = (start + progress) % LUDO_GEOMETRY.ringCells;
        const slot = seat * LUDO_GEOMETRY.ringCells + cell;
        const count = this.#occupancy[slot] ?? 0;
        this.#occupancy[slot] = count + 1;
        this.#occupantToken[slot] = token;
      }
    }
  }

  /** Tokens of other seats on a cell. */
  #opponentsOn(seat: number, cell: number): number {
    let opponents = 0;
    for (const other of this.#seats) {
      if (other === seat) {
        continue;
      }
      opponents += this.#occupancy[other * LUDO_GEOMETRY.ringCells + cell] ?? 0;
    }
    return opponents;
  }

  /** True when an opponent could land on this cell with one roll. */
  #dangerous(seat: number, cell: number): boolean {
    if (this.#safe[cell] === 1) {
      return false;
    }

    const perPlayer = this.#config.tokensPerPlayer;
    const ringSteps = LUDO_GEOMETRY.ringSteps;

    for (const other of this.#seats) {
      if (other === seat) {
        continue;
      }
      const otherStart = this.#starts[other] ?? 0;
      for (let token = 0; token < perPlayer; token += 1) {
        const progress = (this.#progress[other * perPlayer + token] ?? 1) - 1;
        if (progress < 0 || progress > ringSteps - 1) {
          continue;
        }
        const opponentCell = (otherStart + progress) % LUDO_GEOMETRY.ringCells;
        const gap =
          (cell - opponentCell + LUDO_GEOMETRY.ringCells) % LUDO_GEOMETRY.ringCells;
        if (gap >= 1 && gap <= DANGER_RANGE) {
          return true;
        }
      }
    }

    return false;
  }

  /** How many tokens of this seat are home. */
  #homeCount(seat: number): number {
    const perPlayer = this.#config.tokensPerPlayer;
    let home = 0;
    for (let token = 0; token < perPlayer; token += 1) {
      if ((this.#progress[seat * perPlayer + token] ?? 1) - 1 === LUDO_HOME) {
        home += 1;
      }
    }
    return home;
  }

  #isFinishedSeat(seat: number): boolean {
    return this.#homeCount(seat) === this.#config.tokensPerPlayer;
  }

  /** The next seat with tokens left. */
  #advanceTurn(): void {
    const count = this.#seats.length;
    for (let step = 1; step <= count; step += 1) {
      const candidate = (this.#turn + step) % count;
      const seat = this.#seats[candidate] ?? 0;
      if (!this.#isFinishedSeat(seat)) {
        this.#turn = candidate;
        return;
      }
    }
  }

  /** Sends every opponent token on a cell back to its yard. Returns how many. */
  #capture(seat: number, cell: number): number {
    this.#lastCaptureMask = 0;
    if (this.#safe[cell] === 1) {
      return 0;
    }

    const perPlayer = this.#config.tokensPerPlayer;
    let captured = 0;

    for (const other of this.#seats) {
      if (other === seat) {
        continue;
      }
      const slot = other * LUDO_GEOMETRY.ringCells + cell;
      const count = this.#occupancy[slot] ?? 0;
      if (count === 0) {
        continue;
      }
      // The stored occupant is the last token that registered on the cell, which
      // is enough to find each token again by progress.
      for (let token = 0; token < perPlayer; token += 1) {
        const progress = (this.#progress[other * perPlayer + token] ?? 1) - 1;
        if (progress < 0 || progress > LUDO_GEOMETRY.ringSteps - 1) {
          continue;
        }
        if (((this.#starts[other] ?? 0) + progress) % LUDO_GEOMETRY.ringCells === cell) {
          this.#progress[other * perPlayer + token] = YARD_STORED;
          this.#lastCaptureMask |= 1 << other;
          captured += 1;
        }
      }
    }

    return captured;
  }

  /** Notes that a seat has finished, and ends the game when one seat is left. */
  #finishSeat(seat: number): void {
    this.#finishingOrder[this.#finishedSeats] = seat;
    this.#finishedSeats += 1;

    let unfinished = 0;
    let last = 0;
    for (const other of this.#seats) {
      if (!this.#isFinishedSeat(other)) {
        unfinished += 1;
        last = other;
      }
    }

    if (unfinished > 1) {
      return;
    }

    if (unfinished === 1) {
      this.#finishingOrder[this.#finishedSeats] = last;
      this.#finishedSeats += 1;
    }

    this.#status = "finished";
  }

  /**
   * Plays one roll to completion: forfeit, pass, or the policy's move.
   *
   * The parity test drives this and the referee with the same rolls and compares
   * the states, so any divergence between the two implementations fails a test
   * rather than quietly pricing a market wrong.
   */
  playTurn(roll: number, policy: LudoBotId = this.#policy): SimTurnResult {
    if (this.#status === "finished") {
      throw new Error("the game is over");
    }

    const config = this.#config;
    const seat = this.seatToPlay;
    const perPlayer = config.tokensPerPlayer;
    this.#rolls += 1;

    // Three sixes: the turn is forfeited and the third 6 is not played.
    if (config.tripleSixForfeit && roll === config.diceSides && this.#sixes === 2) {
      this.#sixes = 0;
      this.#advanceTurn();
      return {
        captures: 0,
        capturedSeatMask: 0,
        entered: false,
        broughtHome: false,
        forfeited: true,
        passed: false,
      };
    }

    this.#countOccupancy();

    const leavingYard = roll === config.diceSides;
    const block = config.stacking === "block";

    let bestToken = -1;
    let bestFrom = 0;
    let bestTo = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let token = 0; token < perPlayer; token += 1) {
      const from = (this.#progress[seat * perPlayer + token] ?? 1) - 1;
      let to: number;
      let cell = -1;
      let captures = 0;

      if (from === LUDO_YARD) {
        if (!leavingYard) {
          continue;
        }
        to = 0;
        cell = this.#starts[seat] ?? 0;
        const opponents = this.#opponentsOn(seat, cell);
        if (block && opponents >= 2) {
          continue;
        }
        captures = this.#safe[cell] === 1 ? 0 : opponents;
      } else {
        to = from + roll;
        if (to > LUDO_HOME) {
          continue;
        }
        // Only a landing on the ring can capture; the home column belongs to this
        // seat and nothing of an opponent's can be in it.
        if (to < LUDO_GEOMETRY.ringSteps && from <= LUDO_GEOMETRY.ringSteps - 1) {
          cell = ((this.#starts[seat] ?? 0) + to) % LUDO_GEOMETRY.ringCells;
          const opponents = this.#opponentsOn(seat, cell);
          if (block && opponents >= 2) {
            continue;
          }
          captures = this.#safe[cell] === 1 ? 0 : opponents;
        }
      }

      const score = this.#score(policy, seat, token, from, to, cell, captures);
      if (score > bestScore) {
        bestScore = score;
        bestToken = token;
        bestFrom = from;
        bestTo = to;
      }
    }

    if (bestToken === -1) {
      this.#sixes = 0;
      this.#advanceTurn();
      return {
        captures: 0,
        capturedSeatMask: 0,
        entered: false,
        broughtHome: false,
        forfeited: false,
        passed: true,
      };
    }

    // Apply the chosen move.
    this.#progress[seat * perPlayer + bestToken] = bestTo + 1;
    const entered = bestFrom === LUDO_YARD;
    let captured = 0;
    if (bestTo < LUDO_GEOMETRY.ringSteps && bestFrom <= LUDO_GEOMETRY.ringSteps - 1) {
      const cell = ((this.#starts[seat] ?? 0) + bestTo) % LUDO_GEOMETRY.ringCells;
      captured = this.#capture(seat, cell);
    }

    const sixes = roll === config.diceSides ? this.#sixes + 1 : 0;
    const broughtHome = bestTo === LUDO_HOME;

    if (broughtHome && this.#isFinishedSeat(seat)) {
      this.#sixes = 0;
      this.#finishSeat(seat);
      if ((this.#status as "playing" | "finished") === "finished") {
        return {
          captures: captured,
          capturedSeatMask: this.#lastCaptureMask,
          entered,
          broughtHome,
          forfeited: false,
          passed: false,
        };
      }
      this.#advanceTurn();
      return {
        captures: captured,
        capturedSeatMask: this.#lastCaptureMask,
        entered,
        broughtHome,
        forfeited: false,
        passed: false,
      };
    }

    const earnedExtra =
      (roll === config.diceSides && config.extraRollOnSix) ||
      (captured > 0 && config.extraRollOnCapture) ||
      (broughtHome && config.extraRollOnHome);

    if (earnedExtra) {
      this.#sixes = sixes;
    } else {
      this.#sixes = 0;
      this.#advanceTurn();
    }

    return {
      captures: captured,
      capturedSeatMask: this.#lastCaptureMask,
      entered,
      broughtHome,
      forfeited: false,
      passed: false,
    };
  }

  /** The policy's score for one candidate move, matching `bots.ts` exactly. */
  #score(
    policy: LudoBotId,
    seat: number,
    token: number,
    from: number,
    to: number,
    cell: number,
    captures: number,
  ): number {
    void token;
    const homeProgress = LUDO_GEOMETRY.homeProgress + 1;

    if (policy === "racer") {
      let points = to;
      if (to === LUDO_HOME) {
        points += 100;
      }
      if (from === LUDO_YARD) {
        points += 5;
      }
      return points;
    }

    if (policy === "aggressive") {
      let points = captures * 100;
      if (captures > 0 && cell >= 0) {
        // How far along the captured token was; the nearest-home one is dearest.
        for (const other of this.#seats) {
          if (other === seat) {
            continue;
          }
          for (let index = 0; index < this.#config.tokensPerPlayer; index += 1) {
            const progress = (this.#progress[other * this.#config.tokensPerPlayer + index] ?? 1) - 1;
            if (progress < 0 || progress > LUDO_GEOMETRY.ringSteps - 1) {
              continue;
            }
            const otherCell = ((this.#starts[other] ?? 0) + progress) % LUDO_GEOMETRY.ringCells;
            if (otherCell === cell) {
              points = Math.max(points, captures * 100 + progress / 2);
            }
          }
        }
      }
      if (to === LUDO_HOME) {
        points += 40;
      }
      if (to >= LUDO_GEOMETRY.ringSteps) {
        points += 25;
      }
      if (from === LUDO_YARD) {
        points += 15;
      }
      return points + to / homeProgress;
    }

    // Cautious.
    let points = 0;
    if (from >= 0 && from <= LUDO_GEOMETRY.ringSteps - 1) {
      const fromCell = ((this.#starts[seat] ?? 0) + from) % LUDO_GEOMETRY.ringCells;
      if (this.#dangerous(seat, fromCell)) {
        points += 60;
      }
    }
    if (to === LUDO_HOME) {
      points += 55;
    }
    if (to >= LUDO_GEOMETRY.ringSteps) {
      points += 45;
    }
    if (to >= LUDO_GEOMETRY.ringSteps || (cell >= 0 && !this.#dangerous(seat, cell))) {
      points += 30;
    }
    if (from === LUDO_YARD) {
      points += 20;
    }
    if (captures > 0) {
      points += 10;
    }
    return points + to / homeProgress;
  }
}
