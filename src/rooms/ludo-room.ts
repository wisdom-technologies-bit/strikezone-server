import { Client, Room, ServerError } from "colyseus";
import { z } from "zod";
import {
  homeCount,
  type LudoEvent,
  type LudoMove,
  type LudoState,
} from "../engines/ludo/index.js";
import { ludoRunnerSeatsFromMatch, LudoMatchRunner } from "./ludo-match-runner.js";
import { ludoConfigFromMatch } from "../lib/ludo-config.js";
import { LudoRoomState, LudoSeatState, type LudoRoomStateInstance } from "./ludo-room-schema.js";
import { SpectatorHub, SpectatorRefused, spectatorLimitsFromEnv, type SpectatorLimits } from "./spectators.js";
import { STREAM_MESSAGES } from "../api/contract.js";
import { verifyCommit, createMatchSeed } from "../lib/fair-rng.js";
import { matchRepository } from "../lib/match-store.js";
import { supabase } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { isShuttingDown } from "../lib/lifecycle.js";
import type { MatchRecord, MatchRepository, SeatNumber } from "../lib/match-repository.js";
import { LUDO_MOVE_SECONDS } from "./ludo-match-runner.js";

/**
 * The Ludo room.
 *
 * A transport shell around {@link LudoMatchRunner}, built to the same rules as the
 * Carrom room: the server is the only referee, humans authenticate with a Supabase
 * access token, spectators are read-only and anonymous, a dropped player has sixty
 * seconds to come back, and bots wait one to three seconds so their turns read like
 * a person thinking.
 *
 * What a client may send: exactly one message, `{ type: "move", tokenIndex }`, and
 * only while it is that seat's turn. Everything else the room produces itself.
 */

/** Longest a disconnected player has to come back before the clock finishes them. */
export const LUDO_RECONNECTION_SECONDS = 60;

/** The close code Colyseus uses when a client leaves on purpose. */
const CONSENTED_CLOSE_CODE = 4000;

/** How long a finished room stays open so clients can read the result. */
const MATCH_END_GRACE_MS = 10_000;

/** Cap on spectators in one room when the environment does not set one. */
const DEFAULT_MAX_SPECTATORS = 2000;

/** What a join request may carry. */
export const ludoRoomOptionsSchema = z.strictObject({
  matchId: z.string().min(1).max(64).optional(),
  token: z.string().min(10).max(4096).optional(),
  spectate: z.boolean().optional(),
  allowSpectators: z.boolean().optional(),
  /** Server only: the seed, supplied when the room is created by the server. */
  seed: z.string().min(16).max(256).optional(),
});

/** A validated join request. */
export type LudoRoomOptions = z.infer<typeof ludoRoomOptionsSchema>;

/** The only message a player may send. */
export const ludoMoveMessageSchema = z.strictObject({
  type: z.literal("move"),
  tokenIndex: z.number().int().min(0).max(3),
});

/** The auth data attached to a connected client. */
interface ClientAuth {
  readonly spectate: boolean;
  readonly seat: SeatNumber | null;
  readonly userId: string | null;
}

/** What the room needs from the outside world, so tests can supply their own. */
export interface LudoRoomDeps {
  readonly repository: MatchRepository;
  readonly verifyUser: (token: string) => Promise<string | null>;
  readonly botDelayMs: { readonly min: number; readonly max: number };
  readonly reconnectionSeconds?: number;
}

function realDeps(): LudoRoomDeps {
  return {
    repository: matchRepository(),
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await supabase.auth.getUser(token);
      if (error !== null || data.user === null) {
        return null;
      }
      return data.user.id;
    },
    botDelayMs: { min: 1_000, max: 3_000 },
  };
}

let depsOverride: LudoRoomDeps | null = null;

/** Swaps the room's dependencies, for tests. */
export function setLudoRoomDeps(deps: LudoRoomDeps | null): void {
  depsOverride = deps;
}

function roomDeps(): LudoRoomDeps {
  return depsOverride ?? realDeps();
}

/** The events as the stream shows them: one word each, in order. */
function eventNames(events: readonly LudoEvent[]): string[] {
  return events.map((event) => event.type);
}

export class LudoRoom extends Room<{ state: LudoRoomStateInstance }> {
  override maxClients = 4 + DEFAULT_MAX_SPECTATORS;

  #runner: LudoMatchRunner | null = null;
  #match: MatchRecord | null = null;
  #allowSpectators = true;
  #limits: SpectatorLimits = spectatorLimitsFromEnv();
  #hub: SpectatorHub | null = null;
  /** True while a turn is resolved but its message has not gone out. */
  #turnInFlight = false;
  #deferredSnapshots: Client[] = [];

  override async onCreate(rawOptions: unknown): Promise<void> {
    await this.#create(rawOptions);
  }

  async #create(rawOptions: unknown): Promise<void> {
    const parsed = ludoRoomOptionsSchema.safeParse(rawOptions);
    if (!parsed.success) {
      throw new ServerError(4000, "invalid room options");
    }
    const options = parsed.data;

    if (options.matchId === undefined) {
      throw new ServerError(4000, "a match id is required to start a room");
    }
    if (isShuttingDown()) {
      throw new ServerError(4003, "the server is shutting down");
    }

    const deps = roomDeps();
    const match = await deps.repository.get(options.matchId);
    if (match === null) {
      throw new ServerError(4004, "no such match");
    }
    if (match.game !== "ludo") {
      throw new ServerError(4007, "this match is not a ludo match");
    }
    if (match.status === "finished" || match.status === "void") {
      throw new ServerError(4009, `match is ${match.status}`);
    }
    if (match.seedCommit === null) {
      throw new ServerError(4004, "the match has no seed commitment");
    }
    if (options.seed === undefined || !verifyCommit(options.seed, match.seedCommit)) {
      throw new ServerError(4003, "this match can only be started by the server");
    }

    const seats = ludoRunnerSeatsFromMatch(match);
    if (seats.length !== 4 && seats.length !== 2) {
      throw new ServerError(4008, "a ludo match seats two or four players");
    }

    this.#allowSpectators = options.allowSpectators ?? true;
    this.#match = match;
    this.autoDispose = false;
    this.maxClients = seats.length + this.#limits.maxPerRoom;

    this.setState(new LudoRoomState());
    const state = this.state;
    state.matchId = match.id;
    state.seedCommit = match.seedCommit;
    state.moveSeconds = LUDO_MOVE_SECONDS;

    for (const seat of seats) {
      const entry = new LudoSeatState();
      entry.seat = seat.seat;
      entry.playerId = seat.playerId;
      entry.displayName = seat.displayName;
      entry.isBot = seat.isBot;
      entry.botPolicy = seat.botPolicy ?? "";
      entry.connected = seat.isBot;
      for (let token = 0; token < 4; token += 1) {
        entry.progress.push(-1);
      }
      state.players.set(String(seat.seat), entry);
    }

    this.#hub = new SpectatorHub({
      limits: this.#limits,
      transport: {
        send: (sessionId, type, payload) => {
          this.clients.get(sessionId)?.send(type, payload);
        },
        bufferedBytes: (sessionId) => {
          const client = this.clients.get(sessionId);
          const raw = (client as { raw?: { bufferedAmount?: number } } | undefined)?.raw;
          return raw?.bufferedAmount ?? 0;
        },
      },
    });

    this.#runner = new LudoMatchRunner({
      matchId: match.id,
      seed: options.seed,
      seedCommit: match.seedCommit,
      seats,
      repository: deps.repository,
      config: ludoConfigFromMatch(match),
      botDelayMs: deps.botDelayMs,
      // Colyseus' clock, so a room that is closed cannot leave a timer running.
      schedule: (delayMs, run) => {
        const timer = this.clock.setTimeout(run, delayMs);
        return () => {
          timer.clear();
        };
      },
      logger,
      hooks: {
        onRoll: (info) => {
          this.#turnInFlight = true;
          this.#applyTurnState(info.seat, info.roll, info.moves);
          const message = {
            type: "roll" as const,
            matchId: match.id,
            seat: info.seat,
            roll: info.roll,
            tokens: info.moves.map((move) => move.token),
            moveNumber: this.#runner?.moveNumber ?? 0,
            moveSeconds: info.moveSeconds,
            forfeited: info.forfeited,
          };
          this.#sendToSeats(STREAM_MESSAGES.roll, message);
          this.#hub?.broadcast(STREAM_MESSAGES.roll, message);
        },
        onTurn: (info) => {
          this.#turnInFlight = true;
          this.#applyBoardState(info.state, info.seat, info.roll);
          const message = {
            type: "move" as const,
            matchId: match.id,
            seat: info.seat,
            roll: info.roll,
            moveNumber: info.moveNumber,
            token: info.move?.token ?? null,
            from: info.move?.from ?? null,
            to: info.move?.to ?? null,
            events: eventNames(info.events),
            turnSeat: ((info.state.seats[info.state.turn] ?? 0) + 1) as number,
            extraRoll: info.events.some((event) => event.type === "extra_roll"),
          };
          this.#sendToSeats(STREAM_MESSAGES.move, message);
          this.#hub?.broadcast(STREAM_MESSAGES.move, message);
          this.#turnInFlight = false;
          this.#flushDeferredSnapshots();
        },
        onEnd: (info) => {
          this.state.status = "finished";
          this.#applyBoardState(info.state, 1, 0);
          for (const seat of info.result.finishingOrder ?? []) {
            this.state.finishingOrder.push(seat);
          }

          const end = {
            type: "end" as const,
            matchId: match.id,
            winner: info.result.winnerSeat,
            reason: info.result.reason,
            finishingOrder: [...(info.result.finishingOrder ?? [])],
            tokensHome: [...(info.result.tokensHome ?? [])],
            seedReveal: this.#match?.seedReveal ?? null,
            resultSignature: this.#match?.resultSignature ?? null,
          };
          this.#sendToSeats(STREAM_MESSAGES.end, end);
          this.#hub?.broadcast(STREAM_MESSAGES.end, end);

          this.clock.setTimeout(() => {
            void this.disconnect();
          }, MATCH_END_GRACE_MS);
        },
      },
    });

    this.onMessage("move", (client, raw: unknown) => {
      this.#onMove(client, raw);
    });

    await this.#runner.start();
    logger.info({ matchId: match.id, roomId: this.roomId }, "ludo room created");
  }

  override async onAuth(
    client: Client,
    options: unknown,
    context?: { readonly ip?: string },
  ): Promise<ClientAuth> {
    const parsed = ludoRoomOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ServerError(4000, "invalid room options");
    }

    if (parsed.data.spectate === true) {
      if (!this.#allowSpectators) {
        throw new ServerError(4005, "this match does not allow spectators");
      }
      const hub = this.#hub;
      if (hub === null) {
        throw new ServerError(4009, "this match has not started");
      }
      try {
        hub.add(client.sessionId, context?.ip ?? "unknown");
      } catch (error) {
        if (error instanceof SpectatorRefused) {
          throw new ServerError(error.code === "room_full" ? 4029 : 4028, error.message);
        }
        throw error;
      }
      return { spectate: true, seat: null, userId: null };
    }

    if (parsed.data.token === undefined) {
      throw new ServerError(4001, "an access token is required to play");
    }

    const userId = await roomDeps().verifyUser(parsed.data.token);
    if (userId === null) {
      throw new ServerError(4001, "that access token is not valid");
    }

    const seat = this.#seatForUser(userId);
    if (seat === null) {
      throw new ServerError(4002, "you are not seated in this match");
    }

    return { spectate: false, seat, userId };
  }

  override onJoin(client: Client, _options: unknown, auth?: ClientAuth): void {
    const clientAuth = auth ?? { spectate: true, seat: null, userId: null };

    if (clientAuth.spectate || clientAuth.seat === null) {
      client.send(STREAM_MESSAGES.welcome, {
        type: "welcome",
        matchId: this.#match?.id ?? "",
        spectate: true,
        spectators: this.#hub?.count ?? 0,
        moveSeconds: LUDO_MOVE_SECONDS,
      });
      this.#deliverSnapshot(client);
      return;
    }

    this.#setConnected(clientAuth.seat, true);
    const matchId = this.#match?.id;
    if (matchId !== undefined) {
      void roomDeps()
        .repository.recordJoin(matchId, clientAuth.seat, new Date().toISOString())
        .catch((error: unknown) => {
          logger.warn({ err: error, matchId }, "could not record the join");
        });
    }

    client.send(STREAM_MESSAGES.welcome, {
      type: "welcome",
      matchId: this.#match?.id ?? "",
      spectate: false,
      seat: clientAuth.seat,
      moveSeconds: LUDO_MOVE_SECONDS,
    });
    this.#deliverSnapshot(client);
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const auth = client.auth as ClientAuth | undefined;
    if (auth === undefined || auth.spectate || auth.seat === null) {
      this.#hub?.remove(client.sessionId);
      return;
    }

    // 4000 is the code a client sends when it leaves on purpose. Anything else is
    // a dropped connection, which gets the reconnection window.
    this.#setConnected(auth.seat, false);
    if (code === CONSENTED_CLOSE_CODE) {
      return;
    }

    const seconds = roomDeps().reconnectionSeconds ?? LUDO_RECONNECTION_SECONDS;
    try {
      // The seat is held for the reconnection window. Meanwhile the turn clock
      // keeps running, so a player who never returns is finished by timeouts
      // rather than stalling the match.
      await this.allowReconnection(client, seconds);
      this.#setConnected(auth.seat, true);
    } catch (error) {
      logger.info(
        { err: error, matchId: this.#match?.id, seat: auth.seat },
        "ludo player did not return",
      );
    }
  }

  override onDispose(): void {
    this.#runner?.stop();
  }

  /** The message a player sends: one token, validated, then judged by the runner. */
  #onMove(client: Client, raw: unknown): void {
    const auth = client.auth as ClientAuth | undefined;
    const runner = this.#runner;

    if (auth === undefined || auth.spectate || auth.seat === null) {
      client.send(STREAM_MESSAGES.rejected, { code: "spectator", message: "spectators cannot move" });
      return;
    }
    if (runner === null) {
      client.send(STREAM_MESSAGES.rejected, { code: "not_started", message: "the match has not started" });
      return;
    }

    const parsed = ludoMoveMessageSchema.safeParse(raw);
    if (!parsed.success) {
      client.send(STREAM_MESSAGES.rejected, { code: "invalid_message", message: "send { type: \"move\", tokenIndex }" });
      return;
    }

    const refusal = runner.submitMove(auth.seat, parsed.data.tokenIndex);
    if (refusal !== null) {
      client.send(STREAM_MESSAGES.rejected, { code: refusal, message: refusal });
    }
  }

  #seatForUser(userId: string): SeatNumber | null {
    const seats = this.#match?.seats ?? [];
    for (const seat of seats) {
      if (seat.profileId === userId) {
        return seat.seat;
      }
    }
    return null;
  }

  #setConnected(seat: SeatNumber, connected: boolean): void {
    const entry = this.state.players.get(String(seat));
    if (entry !== undefined) {
      entry.connected = connected;
    }
  }

  #sendToSeats(type: string, payload: unknown): void {
    for (const client of this.clients) {
      const auth = client.auth as ClientAuth | undefined;
      if (auth !== undefined && auth.spectate !== true && this.#hub?.has(client.sessionId) !== true) {
        client.send(type, payload);
      }
    }
  }

  /** Writes the roll and whose turn it is into the room state. */
  #applyTurnState(seat: SeatNumber, roll: number, moves: readonly LudoMove[]): void {
    this.state.turnSeat = seat;
    this.state.roll = roll;
    this.state.moveNumber = this.#runner?.moveNumber ?? 0;

    const entry = this.state.players.get(String(seat));
    const human = entry !== undefined && !entry.isBot;
    this.state.turnEndsAt = human ? Date.now() + LUDO_MOVE_SECONDS * 1_000 : 0;

    void moves;
  }

  /** Mirrors the runner's board into the room state. */
  #applyBoardState(state: LudoState, seat: SeatNumber, roll: number): void {
    const roomState = this.state;
    if (roll > 0) {
      roomState.roll = roll;
    }
    roomState.turnSeat = ((state.seats[state.turn] ?? 0) + 1) as number;
    roomState.moveNumber = this.#runner?.moveNumber ?? roomState.moveNumber;

    for (const entry of roomState.players.values()) {
      const seatNumber = entry.seat as SeatNumber;
      entry.home = homeCount(state, seatNumber - 1);
      entry.timeouts = this.#runner?.timeouts(seatNumber) ?? 0;
      entry.progress.clear();
      const base = (seatNumber - 1) * state.config.tokensPerPlayer;
      for (let token = 0; token < state.config.tokensPerPlayer; token += 1) {
        entry.progress.push(state.tokens[base + token] ?? -1);
      }
    }

    void seat;
  }

  /** Sends a viewer the whole board, or defers it until the turn message is out. */
  #deliverSnapshot(client: Client): void {
    const hub = this.#hub;
    if (hub === null) {
      return;
    }
    if (this.#turnInFlight) {
      // A viewer that arrived mid-turn waits for the turn to be published, so it
      // never sees a board that is already stale.
      this.#deferredSnapshots.push(client);
      return;
    }
    hub.sendState(client.sessionId, STREAM_MESSAGES.snapshot, this.#snapshotMessage());
  }

  #flushDeferredSnapshots(): void {
    const waiting = this.#deferredSnapshots;
    this.#deferredSnapshots = [];
    for (const client of waiting) {
      this.#hub?.sendState(client.sessionId, STREAM_MESSAGES.snapshot, this.#snapshotMessage());
    }
  }

  #snapshotMessage(): {
    type: "snapshot";
    matchId: string;
    status: "playing" | "finished";
    turnSeat: number;
    roll: number;
    moveNumber: number;
    seeds: { commit: string; reveal: string | null };
    seats: {
      seat: number;
      displayName: string;
      isBot: boolean;
      botPolicy: string | null;
      connected: boolean;
      home: number;
      progress: number[];
    }[];
    finishingOrder: number[];
  } {
    const seats: {
      seat: number;
      displayName: string;
      isBot: boolean;
      botPolicy: string | null;
      connected: boolean;
      home: number;
      progress: number[];
    }[] = [];

    for (const entry of this.state.players.values()) {
      seats.push({
        seat: entry.seat,
        displayName: entry.displayName,
        isBot: entry.isBot,
        botPolicy: entry.botPolicy === "" ? null : entry.botPolicy,
        connected: entry.connected,
        home: entry.home,
        progress: [...entry.progress],
      });
    }
    seats.sort((left, right) => left.seat - right.seat);

    return {
      type: "snapshot",
      matchId: this.state.matchId,
      status: this.state.status === "finished" ? "finished" : "playing",
      turnSeat: this.state.turnSeat,
      roll: this.state.roll,
      moveNumber: this.state.moveNumber,
      seeds: {
        commit: this.state.seedCommit,
        reveal: this.#match?.seedReveal ?? null,
      },
      seats,
      finishingOrder: [...this.state.finishingOrder],
    };
  }
}

/** A seed for a new ludo match, from the same generator every match uses. */
export function createLudoSeed(): string {
  return createMatchSeed();
}
