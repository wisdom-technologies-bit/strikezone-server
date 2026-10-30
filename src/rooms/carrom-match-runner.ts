import { BOT_POLICIES, safeShot } from "../engines/carrom/bots.js";
import type { BotLevel } from "../engines/carrom/bot-config.js";
import {
  DEFAULT_CARROM_CONFIG,
  resolveConfig,
  type CarromConfig,
} from "../engines/carrom/config.js";
import {
  applyShot,
  createInitialState,
  getLegalStrikerRange,
  type CarromEvent,
  type CarromFrames,
  type CarromShot,
  type CarromState,
} from "../engines/carrom/index.js";
import { createMatchRng, type MatchRng } from "../lib/fair-rng.js";
import { MatchLogBuilder, signResult, type MatchLogEntry } from "../lib/match-log.js";
import type {
  MatchRecord,
  MatchRepository,
  MatchResult,
  MatchSeat,
} from "../lib/match-repository.js";
import { logger as processLogger } from "../lib/logger.js";
import type { Logger } from "pino";

/**
 * The referee.
 *
 * One runner owns one live carrom match: the rules, the clock, the bots, the
 * timeouts, the forfeits and the tamper-evident log. It knows nothing about
 * WebSockets: a Colyseus room wraps it, hands it validated messages and forwards
 * what it emits. That split is what lets a whole match be played, and verified, in
 * a test with no server, no socket and no database.
 *
 * Authority: only the runner decides. A client sends one shot; everything else
 * (turn order, legal placement, scoring, forfeits) is decided here.
 */

/** A seat as the runner sees it. */
export interface RunnerSeat {
  readonly seat: 1 | 2;
  readonly playerId: string;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly botLevel: BotLevel | null;
  readonly botPolicy: string | null;
  readonly skill: Readonly<Record<string, number>>;
}

/** A seat as it is published to clients. */
export interface SeatSnapshot {
  readonly seat: 1 | 2;
  readonly playerId: string;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly botPolicy: string | null;
  readonly score: number;
  readonly pocketed: number;
  readonly timeouts: number;
  readonly connected: boolean;
}

/** The state the room mirrors into its schema and every client can see. */
export interface CarromSnapshot {
  readonly matchId: string;
  readonly status: "live" | "finished";
  readonly board: number;
  readonly turn: "white" | "black";
  readonly turnSeat: 1 | 2;
  readonly phase: "aiming" | "match_ended";
  readonly shotNumber: number;
  /** Epoch milliseconds, or null when it is not a human's turn. */
  readonly turnEndsAt: number | null;
  readonly queenOnBoard: boolean;
  readonly queenPendingSeat: 1 | 2 | null;
  readonly coins: ReadonlyArray<{
    readonly id: string;
    readonly colour: string;
    readonly x: number;
    readonly y: number;
  }>;
  readonly players: readonly SeatSnapshot[];
  /** The commitment published before the first shot. Never the seed itself. */
  readonly seedCommit: string;
}

/** What is broadcast after a shot. */
export interface ShotBroadcast {
  readonly shotNumber: number;
  readonly seat: 1 | 2;
  readonly colour: "white" | "black";
  readonly shot: CarromShot;
  readonly events: readonly CarromEvent[];
  readonly frames: CarromFrames | null;
  readonly nextState: {
    readonly board: number;
    readonly turn: "white" | "black";
    readonly phase: "aiming" | "match_ended";
    readonly queue: readonly {
      readonly id: string;
      readonly colour: string;
      readonly x: number;
      readonly y: number;
    }[];
    readonly scores: { readonly white: number; readonly black: number };
  };
}

/** The outcome of a client's shot message. */
export type SubmitOutcome =
  | { readonly ok: true; readonly shotNumber: number }
  | {
      readonly ok: false;
      readonly code:
        "not_live" | "match_over" | "not_your_turn" | "stale_shot" | "illegal_shot" | "busy";
      readonly message: string;
    };

/** Schedules a callback, and returns a way to cancel it. Injected for tests. */
export interface Scheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export const defaultScheduler: Scheduler = {
  schedule(callback: () => void, delayMs: number): () => void {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

export interface CarromRunnerOptions {
  readonly matchId: string;
  /** The seed. It leaves the server only when the match finishes. */
  readonly seed: string;
  readonly seedCommit: string;
  readonly seats: readonly RunnerSeat[];
  readonly repository: MatchRepository;
  readonly config?: CarromConfig;
  /** Seconds a human has to shoot. Default 30. */
  readonly turnSeconds?: number;
  /** Human-like pause before a bot shoots. Default 1000-3000 ms. */
  readonly botDelayMs?: { readonly min: number; readonly max: number };
  readonly recordFrames?: boolean;
  /** Shots on one board before the match is called off. Default 400. */
  readonly maxShotsPerBoard?: number;
  readonly scheduler?: Scheduler;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly rng?: MatchRng;
  readonly hooks?: {
    readonly onState?: (snapshot: CarromSnapshot) => void;
    /**
     * The shot has been accepted and is about to be simulated. Called before any
     * frame is produced, so a subscriber can act at the instant of the shot.
     */
    readonly onShotStart?: (info: {
      readonly seat: 1 | 2;
      readonly source: "human" | "bot" | "timeout";
      readonly shotNumber: number;
    }) => void;
    readonly onShot?: (payload: ShotBroadcast) => void;
    readonly onEnd?: (result: MatchResult) => void;
  };
}

/** Turn timeouts allowed before the match is forfeited. */
export const TIMEOUTS_BEFORE_FORFEIT = 3;

/**
 * Runs one match from start to finish.
 *
 * Lifecycle: `start()` marks the match live and logs the opening entry, then each
 * turn is either a client shot, a bot shot after its delay, or a timeout. Every
 * shot is applied by the engine here, never by a client, and every result is
 * appended to the hash chain before it is broadcast.
 */
export class CarromMatchRunner {
  readonly #matchId: string;
  readonly #seed: string;
  readonly #seedCommit: string;
  readonly #repository: MatchRepository;
  readonly #config: CarromConfig;
  readonly #turnSeconds: number;
  readonly #botDelayMs: { readonly min: number; readonly max: number };
  readonly #recordFrames: boolean;
  readonly #maxShotsPerBoard: number;
  readonly #scheduler: Scheduler;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #rng: MatchRng;
  readonly #seats: Map<1 | 2, RunnerSeat>;
  readonly #timeouts = new Map<1 | 2, number>();
  readonly #connected = new Map<1 | 2, boolean>();
  readonly #hooks: NonNullable<CarromRunnerOptions["hooks"]>;

  #state: CarromState;
  #log: MatchLogBuilder;
  #status: "live" | "finished" = "live";
  #turnEndsAt: number | null = null;
  #cancelTimer: (() => void) | null = null;
  #resolving = false;
  #boardShots = 0;
  #result: MatchResult | null = null;
  #resolveFinished: ((result: MatchResult) => void) | null = null;
  /** Everything that changes state runs through this queue, one task at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  #botLoopActive = false;
  readonly #finished: Promise<MatchResult>;

  constructor(options: CarromRunnerOptions) {
    this.#matchId = options.matchId;
    this.#seed = options.seed;
    this.#seedCommit = options.seedCommit;
    this.#repository = options.repository;
    this.#config = resolveConfig(options.config ?? DEFAULT_CARROM_CONFIG);
    this.#turnSeconds = options.turnSeconds ?? 30;
    this.#botDelayMs = options.botDelayMs ?? { min: 1_000, max: 3_000 };
    this.#recordFrames = options.recordFrames ?? true;
    this.#maxShotsPerBoard = options.maxShotsPerBoard ?? 400;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#logger = options.logger ?? processLogger;
    this.#now = options.now ?? (() => Date.now());
    this.#rng = options.rng ?? createMatchRng(options.seed, options.matchId);
    this.#hooks = options.hooks ?? {};
    this.#seats = new Map(options.seats.map((seat) => [seat.seat, seat]));

    if (this.#seats.size !== 2) {
      throw new RangeError("a carrom match needs exactly two seats");
    }

    this.#state = createInitialState(this.#config, options.seed);
    this.#log = new MatchLogBuilder(options.seedCommit);
    this.#finished = new Promise<MatchResult>((resolve) => {
      this.#resolveFinished = resolve;
    });

    for (const seat of this.#seats.keys()) {
      this.#timeouts.set(seat, 0);
      this.#connected.set(seat, !this.seatInfo(seat).isBot);
    }
  }

  /** A seat, from either its number or the colour it plays. */
  seatInfo(seat: 1 | 2): RunnerSeat {
    const found = this.#seats.get(seat);
    if (found === undefined) {
      throw new RangeError(`there is no seat ${seat}`);
    }
    return found;
  }

  /** Seat 1 plays white, seat 2 plays black. */
  seatOf(colour: "white" | "black"): 1 | 2 {
    return colour === "white" ? 1 : 2;
  }

  /** The seat whose turn it is. */
  get turnSeat(): 1 | 2 {
    return this.seatOf(this.#state.turn);
  }

  /** The current state, safe to publish: the seed is never in it. */
  get snapshot(): CarromSnapshot {
    const players: SeatSnapshot[] = ([1, 2] as const).map((seat) => {
      const info = this.seatInfo(seat);
      const tallies = this.#state.players[this.colourOf(seat)];

      return {
        seat,
        playerId: info.playerId,
        displayName: info.displayName,
        isBot: info.isBot,
        botPolicy: info.botPolicy,
        score: tallies.score,
        pocketed: tallies.pocketed,
        timeouts: this.#timeouts.get(seat) ?? 0,
        connected: this.#connected.get(seat) ?? false,
      };
    });

    return {
      matchId: this.#matchId,
      status: this.#status,
      board: this.#state.board,
      turn: this.#state.turn,
      turnSeat: this.turnSeat,
      phase: this.#state.phase,
      shotNumber: this.#state.shot,
      turnEndsAt: this.#turnEndsAt,
      queenOnBoard: this.#state.queen.onBoard,
      queenPendingSeat:
        this.#state.queen.pending === null ? null : this.seatOf(this.#state.queen.pending),
      coins: this.#state.coins.map((coin) => ({
        id: coin.id,
        colour: coin.colour,
        x: coin.x,
        y: coin.y,
      })),
      players,
      seedCommit: this.#seedCommit,
    };
  }

  /** Resolves when the match ends, however it ends. */
  get finished(): Promise<MatchResult> {
    return this.#finished;
  }

  /** The final result, once there is one. */
  get result(): MatchResult | null {
    return this.#result;
  }

  /** The log entries written so far, for tests and for the in-process verifier. */
  get logEntries(): readonly MatchLogEntry[] {
    return this.#log.entries;
  }

  /** The current chain head, which is the signature's other half. */
  get logHead(): string {
    return this.#log.head;
  }

  /** Runs a task after every task already queued. State changes never overlap. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Starts the match: marks it live, logs the opening entry, begins the turn. */
  async start(): Promise<void> {
    return this.#enqueue(() => this.#start());
  }

  async #start(): Promise<void> {
    if (this.#status === "finished") {
      throw new MatchRepositoryErrorLike("this match has already finished");
    }

    const startedAt = new Date(this.#now()).toISOString();
    await this.#repository.markLive(this.#matchId, {
      seedCommit: this.#seedCommit,
      startedAt,
    });

    this.#append("match_start", {
      matchId: this.#matchId,
      seedCommit: this.#seedCommit,
      startedAt,
      turnSeconds: this.#turnSeconds,
      seats: [...this.#seats.values()].map((seat) => ({
        seat: seat.seat,
        playerId: seat.playerId,
        displayName: seat.displayName,
        isBot: seat.isBot,
        botPolicy: seat.botPolicy,
      })),
    });
    await this.#flush();

    this.#logger.info(
      { matchId: this.#matchId, seats: [...this.#seats.values()].map((seat) => seat.seat) },
      "carrom match started",
    );

    this.#beginTurn();
  }

  /**
   * A client's shot.
   *
   * Everything is checked here, in this order: the match must be live, it must be
   * this seat's turn, the message must be for the current shot number, and the
   * engine must accept the placement and the power. Only then is it applied.
   */
  async submitShot(
    seat: 1 | 2,
    shot: CarromShot,
    options: { readonly expectedShot?: number } = {},
  ): Promise<SubmitOutcome> {
    return this.#enqueue(() => this.#submit(seat, shot, options));
  }

  async #submit(
    seat: 1 | 2,
    shot: CarromShot,
    options: { readonly expectedShot?: number },
  ): Promise<SubmitOutcome> {
    if (this.#status !== "live") {
      return { ok: false, code: "not_live", message: "the match is not live" };
    }
    if (this.#state.phase === "match_ended") {
      return { ok: false, code: "match_over", message: "the match has ended" };
    }
    // A message aimed at a move that has already happened is stale whatever else
    // is true of it: the client is working from an old position.
    if (options.expectedShot !== undefined && options.expectedShot !== this.#state.shot) {
      return {
        ok: false,
        code: "stale_shot",
        message: `that shot was for move ${options.expectedShot}, it is move ${this.#state.shot} now`,
      };
    }
    if (seat !== this.turnSeat) {
      return { ok: false, code: "not_your_turn", message: "it is not your turn" };
    }
    if (this.#resolving) {
      return { ok: false, code: "busy", message: "the previous shot is still being resolved" };
    }

    const applied = await this.#playShot(seat, shot, "human");
    if (!applied.ok) {
      return applied;
    }

    await this.#continueAfterShot();
    return { ok: true, shotNumber: this.#state.shot };
  }

  /** A human's reconnection window closed, or they left: forfeit the match. */
  async forfeit(seat: 1 | 2, reason: "timeout" | "disconnect" | "left"): Promise<void> {
    return this.#enqueue(() => this.#doForfeit(seat, reason));
  }

  async #doForfeit(seat: 1 | 2, reason: "timeout" | "disconnect" | "left"): Promise<void> {
    if (this.#status === "finished") {
      return;
    }
    this.#append("player_forfeit", { seat, reason, at: new Date(this.#now()).toISOString() });
    this.#logger.info({ matchId: this.#matchId, seat, reason }, "carrom match forfeited");
    await this.#finishMatch("forfeit", this.otherSeat(seat));
  }

  /** Marks a seat present or absent, for the room's reconnection handling. */
  setConnected(seat: 1 | 2, connected: boolean): void {
    this.#connected.set(seat, connected);
    this.#emitState();
  }

  /** Clears timers. Called when the room is disposed. */
  dispose(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  /** Waits for any run of zero-delay bot turns to finish. */
  async settle(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#status === "finished") {
        return;
      }
      await this.#runDueBots();
    });
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  private colourOf(seat: 1 | 2): "white" | "black" {
    return seat === 1 ? "white" : "black";
  }

  private otherSeat(seat: 1 | 2): 1 | 2 {
    return seat === 1 ? 2 : 1;
  }

  private botDelay(): number {
    const { min, max } = this.#botDelayMs;
    if (max <= 0) {
      return 0;
    }
    const width = Math.max(0, max - min);
    return Math.round(min + this.#rng.nextFloat() * width);
  }

  #beginTurn(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;

    if (this.#status === "finished" || this.#state.phase === "match_ended") {
      this.#turnEndsAt = null;
      this.#emitState();
      return;
    }

    const seat = this.turnSeat;
    const info = this.seatInfo(seat);

    if (info.isBot) {
      // Bots are not on a clock; they move after a human-like pause.
      this.#turnEndsAt = null;
      this.#emitState();

      if (this.#botDelayMs.max <= 0) {
        this.#scheduleBotLoop();
        return;
      }

      this.#cancelTimer = this.#scheduler.schedule(() => {
        void this.#enqueue(() => this.#playBotTurn());
      }, this.botDelay());
      return;
    }

    this.#turnEndsAt = this.#now() + this.#turnSeconds * 1_000;
    this.#emitState();
    this.#cancelTimer = this.#scheduler.schedule(() => {
      void this.#enqueue(() => this.#onTurnTimeout());
    }, this.#turnSeconds * 1_000);
  }

  #scheduleBotLoop(): void {
    void this.#enqueue(() => this.#runDueBots());
  }

  /** Plays every bot turn that is due, one at a time, until a human is on turn. */
  async #runDueBots(): Promise<void> {
    if (this.#botLoopActive) {
      return;
    }
    this.#botLoopActive = true;

    try {
      while (this.#status === "live" && this.#state.phase === "aiming") {
        if (!this.seatInfo(this.turnSeat).isBot || this.#botDelayMs.max > 0) {
          return;
        }
        await this.#playBotTurn();
      }
    } finally {
      this.#botLoopActive = false;
    }
  }

  async #playBotTurn(): Promise<void> {
    if (this.#status === "finished" || this.#state.phase === "match_ended") {
      return;
    }

    const seat = this.turnSeat;
    const info = this.seatInfo(seat);
    if (!info.isBot || info.botLevel === null) {
      return;
    }

    const policy = BOT_POLICIES[info.botLevel];
    const shot = policy.chooseShot(this.#state, this.#rng, info.skill, this.#config);
    const applied = await this.#playShot(seat, shot, "bot");

    if (!applied.ok) {
      // A bot must never produce an illegal shot, but if it somehow does, fall
      // back to the safe shot rather than stalling the match.
      this.#logger.warn(
        { matchId: this.#matchId, seat, code: applied.code, reason: applied.message },
        "bot produced a shot the engine refused; playing the safe shot instead",
      );
      const fallback = await this.#playShot(seat, safeShot(this.#state, this.#config), "bot");
      if (!fallback.ok) {
        await this.#doForfeit(seat, "left");
        return;
      }
    }

    await this.#continueAfterShot();
  }

  async #onTurnTimeout(): Promise<void> {
    if (this.#status === "finished" || this.#state.phase === "match_ended") {
      return;
    }

    const seat = this.turnSeat;
    if (this.seatInfo(seat).isBot) {
      return;
    }

    const timeouts = (this.#timeouts.get(seat) ?? 0) + 1;
    this.#timeouts.set(seat, timeouts);
    this.#append("turn_timeout", { seat, timeouts, at: new Date(this.#now()).toISOString() });

    if (timeouts >= TIMEOUTS_BEFORE_FORFEIT) {
      this.#logger.info(
        { matchId: this.#matchId, seat, timeouts },
        "carrom seat forfeited on time",
      );
      await this.#doForfeit(seat, "timeout");
      return;
    }

    // Play a safe shot for them so the match keeps moving.
    const applied = await this.#playShot(seat, safeShot(this.#state, this.#config), "timeout");
    if (!applied.ok) {
      this.#logger.warn({ matchId: this.#matchId, seat }, "timeout shot was refused");
      return;
    }

    await this.#continueAfterShot();
  }

  async #continueAfterShot(): Promise<void> {
    if (this.#status === "finished") {
      return;
    }

    if (this.#state.phase === "match_ended") {
      await this.#finishMatch("scored", null);
      return;
    }

    if (this.#boardShots >= this.#maxShotsPerBoard) {
      this.#logger.warn(
        { matchId: this.#matchId, board: this.#state.board, shots: this.#boardShots },
        "board hit its shot limit, calling the match off",
      );
      await this.#finishMatch("board_limit", null);
      return;
    }

    this.#beginTurn();
  }

  // -------------------------------------------------------------------------
  // Applying a shot
  // -------------------------------------------------------------------------

  async #playShot(
    seat: 1 | 2,
    shot: CarromShot,
    source: "human" | "bot" | "timeout",
  ): Promise<SubmitOutcome> {
    if (seat !== this.turnSeat) {
      return { ok: false, code: "not_your_turn", message: "it is not your turn" };
    }

    const shootingColour = this.#state.turn;
    const boardBefore = this.#state.board;

    // Announced before the simulation runs, so `shot.received` reaches the bus
    // before a single frame of this shot exists, let alone leaves the server.
    this.#hooks.onShotStart?.({
      seat,
      source,
      shotNumber: this.#state.shot + 1,
    });

    let applied: ReturnType<typeof applyShot>;
    try {
      applied = applyShot(this.#state, shot, {
        config: this.#config,
        recordFrames: this.#recordFrames,
        fps: this.#config.framesPerSecond,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "shot refused";
      return { ok: false, code: "illegal_shot", message };
    }

    this.#resolving = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;

    const shotNumber = this.#state.shot + 1;
    const legalRange = getLegalStrikerRange(this.#state, this.#config);

    this.#append("shot", {
      shotNumber,
      seat,
      colour: shootingColour,
      source,
      shot: {
        x: shot.strikerPosition.x,
        y: shot.strikerPosition.y,
        angle: shot.angle,
        power: shot.power,
      },
      baselineY: legalRange.y,
      turnSeconds: this.#turnSeconds,
    });

    for (const event of applied.events) {
      this.#append(event.type, { ...event });
    }

    this.#state = applied.state;
    this.#boardShots = applied.state.board === boardBefore ? this.#boardShots + 1 : 0;

    await this.#flush();

    this.#resolving = false;

    this.#hooks.onShot?.({
      shotNumber,
      seat,
      colour: shootingColour,
      shot,
      events: applied.events,
      frames: applied.frames,
      nextState: {
        board: this.#state.board,
        turn: this.#state.turn,
        phase: this.#state.phase,
        queue: this.#state.coins.map((coin) => ({
          id: coin.id,
          colour: coin.colour,
          x: coin.x,
          y: coin.y,
        })),
        scores: {
          white: this.#state.players.white.score,
          black: this.#state.players.black.score,
        },
      },
    });
    this.#emitState();

    return { ok: true, shotNumber };
  }

  // -------------------------------------------------------------------------
  // Log, emit, finish
  // -------------------------------------------------------------------------

  #append(type: string, payload: Readonly<Record<string, unknown>>): void {
    this.#log.append(type, payload);
  }

  async #flush(): Promise<void> {
    const pending = this.#log.entries.slice(this.#flushed);
    if (pending.length === 0) {
      return;
    }

    await this.#repository.appendEvents(this.#matchId, pending);
    this.#flushed = this.#log.entries.length;
  }

  #flushed = 0;

  async #finishMatch(reason: MatchResult["reason"], forcedWinner: 1 | 2 | null): Promise<void> {
    if (this.#status === "finished") {
      return;
    }

    this.#status = "finished";
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#turnEndsAt = null;

    const result = this.#buildResult(reason, forcedWinner);

    // Seal the log first, then take the head and sign over it, so the signature
    // covers the closing entry too.
    this.#append("match_end", { ...result });
    await this.#flush();

    const logHeadHash = this.#log.head;
    const signature = signResult(result, logHeadHash);

    await this.#repository.finish(this.#matchId, {
      seedReveal: this.#seed,
      result,
      resultSignature: signature,
      logHeadHash,
      endedAt: new Date(this.#now()).toISOString(),
    });

    this.#result = result;
    this.#emitState();
    this.#hooks.onEnd?.(result);
    this.#resolveFinished?.(result);
    this.#resolveFinished = null;

    this.#logger.info(
      {
        matchId: this.#matchId,
        reason,
        winnerSeat: result.winnerSeat,
        shots: result.shots,
        boards: result.boards,
      },
      "carrom match finished",
    );
  }

  #buildResult(reason: MatchResult["reason"], forcedWinner: 1 | 2 | null): MatchResult {
    const scores = {
      white: this.#state.players.white.score,
      black: this.#state.players.black.score,
    };

    if (forcedWinner !== null) {
      return {
        winnerSeat: forcedWinner,
        winnerColour: this.colourOf(forcedWinner),
        scores,
        boards: this.#state.board,
        shots: this.#state.shot,
        reason,
        seedDraws: this.#rng.draws,
      };
    }

    const winnerColour =
      scores.white === scores.black ? "tie" : scores.white > scores.black ? "white" : "black";

    return {
      winnerSeat: winnerColour === "tie" ? null : this.seatOf(winnerColour),
      winnerColour,
      scores,
      boards: this.#state.board,
      shots: this.#state.shot,
      reason,
      seedDraws: this.#rng.draws,
    };
  }

  #emitState(): void {
    this.#hooks.onState?.(this.snapshot);
  }
}

/** A repository-style failure the runner raises itself. */
class MatchRepositoryErrorLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchRepositoryError";
  }
}

/**
 * Builds runner seats from a stored match.
 *
 * Carrom seats two, so a seat number outside 1 and 2 is a match for the other
 * game: it is dropped rather than mistyped into the shape carrom expects.
 */
export function runnerSeatsFromMatch(match: MatchRecord): RunnerSeat[] {
  return match.seats
    .filter((seat: MatchSeat) => seat.seat === 1 || seat.seat === 2)
    .map((seat: MatchSeat) => ({
      seat: seat.seat === 1 ? 1 : 2,
    playerId: seat.playerId,
    displayName: seat.displayName,
    isBot: seat.isBot,
    botLevel: seat.botLevel,
      botPolicy: seat.botPolicy,
      skill: seat.skill,
    }));
}
