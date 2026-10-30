import { Client, Room, ServerError } from "colyseus";
import { z } from "zod";
import { BOT_LEVELS, type BotLevel } from "../engines/carrom/bot-config.js";
import { carromConfigFromMatch } from "../lib/match-verify.js";
import { verifyCommit } from "../lib/fair-rng.js";
import { matchRepository } from "../lib/match-store.js";
import type { MatchRecord, MatchRepository, MatchResult } from "../lib/match-repository.js";
import { supabase } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { createMessageGuard, VIOLATIONS_BEFORE_LEAVE, type MessageGuard } from "./message-guard.js";
import { isShuttingDown } from "../lib/lifecycle.js";
import { publish } from "../lib/events.js";
import {
  CarromMatchRunner,
  runnerSeatsFromMatch,
  type CarromSnapshot,
  type RunnerSeat,
  type ShotBroadcast,
} from "./carrom-match-runner.js";
import { STREAM_MESSAGES } from "../api/contract.js";
import {
  SpectatorHub,
  SpectatorRefused,
  spectatorLimitsFromEnv,
  type SpectatorLimits,
} from "./spectators.js";
import { buildEndMessage, buildShotMessage, buildSnapshot } from "./stream-messages.js";
import {
  CarromCoinState,
  CarromRoomState,
  CarromSeatState,
  type CarromRoomStateInstance,
} from "./carrom-room-schema.js";

/**
 * The carrom room.
 *
 * A thin transport shell around {@link CarromMatchRunner}: it authenticates
 * joins, validates every message with zod, mirrors the referee's snapshots into
 * Colyseus state and forwards what the referee emits. It never decides a rule
 * itself, and it never applies a shot itself.
 *
 * Who may do what:
 * - A seated human joins with a Supabase access token. The token is checked with
 *   `supabase.auth.getUser`, and the user must hold a seat in this match.
 * - A spectator joins with `{ spectate: true }` and may be anonymous. Spectators
 *   receive everything and may send nothing.
 * - Bots are seated by the server and never connect at all.
 */

/** Longest a disconnected player has to come back before losing the match. */
export const RECONNECTION_SECONDS = 60;

/**
 * The close code Colyseus uses when a client leaves on purpose (its
 * `CloseCode.CONSENTED`). Anything else is a dropped connection, which gets the
 * reconnection window instead of an immediate forfeit.
 */
const CONSENTED_CLOSE_CODE = 4000;

/** Cap on spectators in one room when the environment does not set one. */
const DEFAULT_MAX_SPECTATORS = 2000;

/** How long a finished room stays open so clients can read the result. */
const MATCH_END_GRACE_MS = 10_000;

/** The two ways a seat can be taken when the server starts a match. */
export const seatOptionSchema = z.union([
  z.strictObject({ kind: z.literal("human"), playerId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("bot"), level: z.enum(BOT_LEVELS) }),
]);

/**
 * What a join request may carry.
 *
 * `matchId` names the match; the seats and the clock are checked against the
 * stored match rather than trusted, so a client cannot seat itself or stretch the
 * timer. `seed` is accepted only from the server, and only if it hashes to the
 * commitment already published for the match.
 */
export const carromRoomOptionsSchema = z.strictObject({
  /** Required when the server creates the room; joins may omit it. */
  matchId: z.string().min(1).max(64).optional(),
  token: z.string().min(10).max(4096).optional(),
  spectate: z.boolean().optional(),
  seats: z.array(seatOptionSchema).length(2).optional(),
  turnSeconds: z.number().int().min(5).max(300).optional(),
  allowSpectators: z.boolean().optional(),
  /** Server only: the seed, supplied when the room is created by the server. */
  seed: z.string().min(16).max(256).optional(),
});

/** A validated join request. */
export type CarromRoomOptions = z.infer<typeof carromRoomOptionsSchema>;

/** The shot message: `{ type: "shot", shot, expectedShot? }`. */
export const shotMessageSchema = z.strictObject({
  type: z.literal("shot"),
  shot: z.strictObject({
    strikerPosition: z.strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
    }),
    angle: z.number().finite().min(-Math.PI).max(Math.PI),
    power: z.number().finite().min(0).max(1),
  }),
  /**
   * The move number the client believes it is shooting for. Optional, but a
   * client that sends it can never double-shoot: the second message names a move
   * that has already happened.
   */
  expectedShot: z.number().int().min(0).optional(),
});

/** The auth data attached to a connected client. */
interface ClientAuth {
  readonly spectate: boolean;
  /** The seat this client plays, or null for a spectator. */
  readonly seat: 1 | 2 | null;
  readonly userId: string | null;
}

/** What the room needs from the outside world, so tests can supply their own. */
export interface CarromRoomDeps {
  readonly repository: MatchRepository;
  /** Resolves a Supabase access token to a user id, or null when it is invalid. */
  readonly verifyUser: (token: string) => Promise<string | null>;
  /** How long bots pause before shooting. */
  readonly botDelayMs: { readonly min: number; readonly max: number };
  /** Seconds a dropped player has to come back. Defaults to 60. */
  readonly reconnectionSeconds?: number;
}

function realDeps(): CarromRoomDeps {
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

let depsOverride: CarromRoomDeps | null = null;

/** Swaps the room's dependencies, for tests. */
export function setCarromRoomDeps(deps: CarromRoomDeps | null): void {
  depsOverride = deps;
}

function roomDeps(): CarromRoomDeps {
  return depsOverride ?? realDeps();
}

export class CarromRoom extends Room<{ state: CarromRoomStateInstance }> {
  override maxClients = 2 + DEFAULT_MAX_SPECTATORS;

  #runner: CarromMatchRunner | null = null;
  #match: MatchRecord | null = null;
  #turnSeconds = 30;
  #allowSpectators = true;
  #limits: SpectatorLimits = spectatorLimitsFromEnv();
  #hub: SpectatorHub | null = null;
  /**
   * True between a shot being accepted and its frames being sent. A spectator
   * that joins inside that window waits for the shot to finish, so it never gets a
   * snapshot of a board mid-flight followed by frames that started before it.
   */
  #shotInFlight = false;
  #deferredSnapshots: Client[] = [];

  override async onCreate(rawOptions: unknown): Promise<void> {
    // Awaited by Colyseus: no client can join until the match is loaded and the
    // referee has started.
    await this.#create(rawOptions);
  }

  async #create(rawOptions: unknown): Promise<void> {
    const parsed = carromRoomOptionsSchema.safeParse(rawOptions);
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
    if (match.status === "finished" || match.status === "void") {
      throw new ServerError(4009, `match is ${match.status}`);
    }
    if (match.seedCommit === null) {
      throw new ServerError(4004, "the match has no seed commitment");
    }

    // The seed is server-supplied and must hash to the published commitment, so a
    // client cannot start a match on a stream of its own choosing.
    if (options.seed === undefined || !verifyCommit(options.seed, match.seedCommit)) {
      throw new ServerError(4003, "this match can only be started by the server");
    }

    const seats = runnerSeatsFromMatch(match);
    if (options.seats !== undefined && !seatsMatchOptions(seats, options.seats)) {
      throw new ServerError(4008, "the seats do not match the match");
    }

    const config = carromConfigFromMatch(match);
    const storedTurnSeconds = match.config["turnSeconds"];
    this.#turnSeconds =
      options.turnSeconds ?? (typeof storedTurnSeconds === "number" ? storedTurnSeconds : 30);
    this.#allowSpectators = options.allowSpectators ?? true;
    this.#match = match;

    // A room outlives its clients on purpose: while a match is live a dropped
    // player has a reconnection window, and one failed join attempt must not be
    // able to dispose the room for everyone else. It closes after the match ends.
    this.autoDispose = false;

    this.maxClients = 2 + this.#limits.maxPerRoom;

    this.setState(new CarromRoomState());
    this.state.matchId = match.id;
    this.state.seedCommit = match.seedCommit;
    this.state.turnSeconds = this.#turnSeconds;

    this.#hub = new SpectatorHub({
      limits: this.#limits,
      transport: {
        send: (sessionId, type, payload) => {
          this.clients.get(sessionId)?.send(type, payload);
        },
        // The socket tells us how far behind a viewer is. When it cannot, zero
        // means "assume healthy": the mailbox is never grown on a guess.
        bufferedBytes: (sessionId) => {
          const client = this.clients.get(sessionId);
          const raw = (client as { raw?: { bufferedAmount?: number } } | undefined)?.raw;
          return raw?.bufferedAmount ?? 0;
        },
      },
    });

    this.#runner = new CarromMatchRunner({
      matchId: match.id,
      seed: options.seed,
      seedCommit: match.seedCommit,
      seats,
      repository: deps.repository,
      config,
      turnSeconds: this.#turnSeconds,
      botDelayMs: deps.botDelayMs,
      logger,
      hooks: {
        onState: (snapshot) => {
          this.#applySnapshot(snapshot);
        },
        onShotStart: (info) => {
          this.#shotInFlight = true;
          // Before a single frame exists, let whoever is trading this match know a
          // shot is under way. This is the fairness guarantee, so it is published
          // here rather than beside the broadcast below.
          void publish("shot.received", {
            matchId: this.#match?.id ?? "",
            game: "carrom",
            seat: info.seat,
            source: info.source,
            shotNumber: info.shotNumber,
          });
        },
        onShot: (payload) => {
          // Seats get the referee's own payload; spectators get the quantised
          // message below. A broadcast would reach both and send the shot twice.
          this.#sendToSeats("shot", payload);
          // The odds engine suspends and reprices on this. Publishing costs the
          // room nothing and it never subscribes to anything (hard rule 4).
          void publish("match.shot", {
            matchId: this.#match?.id ?? "",
            game: "carrom",
            seat: payload.seat,
            shotNumber: payload.shotNumber,
          });

          // Spectators get the recording quantised, and are skipped rather than
          // buffered when their socket is behind (see rooms/spectators.ts).
          this.#sendShotToSpectators(payload);
        },
        onEnd: (result) => {
          this.#sendToSeats("match_end", result);
          this.#hub?.broadcastEnd(
            buildEndMessage(result, {
              matchId: this.#match?.id ?? "",
              seedReveal: this.#match?.seedReveal ?? null,
              resultSignature: this.#match?.resultSignature ?? null,
            }),
          );
          // Give clients a moment to read the result, then close the room.
          this.clock.setTimeout(() => {
            void this.disconnect();
          }, MATCH_END_GRACE_MS);
        },
      },
    });

    // A shot is a handful of numbers. Anything larger, or anything arriving faster
    // than a person can aim, is refused before the runner sees it, and a client
    // that keeps it up is disconnected rather than allowed to occupy the room.
    const shotGuard = createMessageGuard();

    this.onMessage("shot", (client, raw: unknown) => {
      if (!this.#messageAllowed(shotGuard, client, raw)) {
        return;
      }
      void this.#onShot(client, raw);
    });

    const runner = this.#runner;
    await runner.start();
    logger.info({ matchId: match.id, roomId: this.roomId }, "carrom room created");
  }

  /** Refuses a message the guard rejects, and hangs up on a repeat offender. */
  #messageAllowed(guard: MessageGuard, client: Client, raw: unknown): boolean {
    const verdict = guard.check(client.sessionId, raw);
    if (verdict === "ok") {
      return true;
    }

    logger.warn(
      { matchId: this.#match?.id ?? null, roomId: this.roomId, verdict },
      "refused a room message",
    );

    if (guard.violations(client.sessionId) >= VIOLATIONS_BEFORE_LEAVE) {
      client.leave(4008);
    }
    return false;
  }

  override async onAuth(
    client: Client,
    options: unknown,
    context?: { readonly ip?: string },
  ): Promise<ClientAuth> {
    const parsed = carromRoomOptionsSchema.safeParse(options);
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

    void client;
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
        fps: this.#match?.config["framesPerSecond"] ?? 30,
      });
      this.#deliverSnapshot(client);
      logger.debug({ matchId: this.#match?.id, sessionId: client.sessionId }, "spectator joined");
      return;
    }

    this.#runner?.setConnected(clientAuth.seat, true);

    // The tournament walkover rule asks whether a human ever turned up, so the
    // first join is written down. It is bookkeeping, never a rule of the match.
    const matchId = this.#match?.id;
    if (matchId !== undefined) {
      void roomDeps()
        .repository.recordJoin(matchId, clientAuth.seat, new Date().toISOString())
        .catch((error: unknown) => {
          logger.warn({ err: error, matchId }, "could not record the join");
        });
    }

    client.send("welcome", {
      matchId: this.#match?.id ?? "",
      spectate: false,
      seat: clientAuth.seat,
      turnSeconds: this.#turnSeconds,
      seedCommit: this.#match?.seedCommit ?? "",
    });
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const auth = client.auth as ClientAuth | undefined;

    if (auth === undefined || auth.spectate || auth.seat === null) {
      this.#hub?.remove(client.sessionId);
      this.#deferredSnapshots = this.#deferredSnapshots.filter((waiting) => waiting !== client);
      return;
    }

    const seat = auth.seat;
    this.#runner?.setConnected(seat, false);

    if (code === CONSENTED_CLOSE_CODE) {
      await this.#runner?.forfeit(seat, "left");
      return;
    }

    try {
      await this.allowReconnection(client, roomDeps().reconnectionSeconds ?? RECONNECTION_SECONDS);
      this.#runner?.setConnected(seat, true);
    } catch {
      logger.info({ matchId: this.#match?.id, seat }, "seat did not reconnect, forfeiting");
      await this.#runner?.forfeit(seat, "disconnect");
    }
  }

  override onDispose(): void {
    this.#runner?.dispose();
    logger.info({ matchId: this.#match?.id, roomId: this.roomId }, "carrom room disposed");
  }

  // -------------------------------------------------------------------------

  async #onShot(client: Client, raw: unknown): Promise<void> {
    const runner = this.#runner;
    const auth = client.auth as ClientAuth | undefined;

    if (runner === null) {
      client.send("rejected", { code: "not_live", message: "the match has not started" });
      return;
    }
    if (auth === undefined || auth.spectate || auth.seat === null) {
      client.send("rejected", {
        code: "spectator",
        message: "spectators receive the match but cannot play in it",
      });
      return;
    }

    const parsed = shotMessageSchema.safeParse(raw);
    if (!parsed.success) {
      client.send("rejected", {
        code: "invalid_message",
        message: "the shot message is not valid",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const outcome = await runner.submitShot(auth.seat, parsed.data.shot, {
      expectedShot: parsed.data.expectedShot,
    });

    if (!outcome.ok) {
      client.send("rejected", { code: outcome.code, message: outcome.message });
    }
  }

  /**
   * Sends the full state to one spectator, or holds it until the shot in flight
   * has been broadcast. Joining mid-shot therefore yields the state after that
   * shot, which is the only snapshot whose frames the viewer will also receive.
   */
  #deliverSnapshot(client: Client): void {
    const hub = this.#hub;
    if (hub === null) {
      return;
    }

    if (this.#shotInFlight) {
      this.#deferredSnapshots.push(client);
      return;
    }

    hub.sendSnapshot(client.sessionId, buildSnapshot(this.state));
  }

  /** Sends a message to the players only. Spectators are never included. */
  #sendToSeats(type: string, payload: unknown): void {
    for (const client of this.clients) {
      if (this.#hub?.has(client.sessionId) !== true) {
        client.send(type, payload);
      }
    }
  }

  /** The shot, quantised, to every spectator that can take it. */
  #sendShotToSpectators(payload: ShotBroadcast): void {
    const hub = this.#hub;
    if (hub === null) {
      return;
    }

    hub.broadcastShot(buildShotMessage(payload));
    hub.warnIfLagging(this.#match?.id ?? "");

    this.#shotInFlight = false;

    const waiting = this.#deferredSnapshots;
    this.#deferredSnapshots = [];
    for (const client of waiting) {
      hub.sendSnapshot(client.sessionId, buildSnapshot(this.state));
    }
  }

  #seatForUser(userId: string): 1 | 2 | null {
    const seats = this.#match?.seats ?? [];
    for (const seat of seats) {
      // Carrom seats two; a wider seat number cannot be authorised here.
      if (seat.profileId === userId && (seat.seat === 1 || seat.seat === 2)) {
        return seat.seat;
      }
    }
    return null;
  }

  #applySnapshot(snapshot: CarromSnapshot): void {
    const state = this.state;

    state.status = snapshot.status;
    state.board = snapshot.board;
    state.turn = snapshot.turn;
    state.turnSeat = snapshot.turnSeat;
    state.phase = snapshot.phase;
    state.shotNumber = snapshot.shotNumber;
    state.turnEndsAt = snapshot.turnEndsAt ?? 0;
    state.queenOnBoard = snapshot.queenOnBoard;
    state.queenPendingSeat = snapshot.queenPendingSeat ?? 0;

    for (const seat of snapshot.players) {
      const key = String(seat.seat);
      const existing = state.seats.get(key);

      if (existing === undefined) {
        const created = new CarromSeatState();
        created.seat = seat.seat;
        created.playerId = seat.playerId;
        created.displayName = seat.displayName;
        created.isBot = seat.isBot;
        created.botPolicy = seat.botPolicy ?? "";
        created.score = seat.score;
        created.pocketed = seat.pocketed;
        created.timeouts = seat.timeouts;
        created.connected = seat.connected;
        state.seats.set(key, created);
        continue;
      }

      existing.score = seat.score;
      existing.pocketed = seat.pocketed;
      existing.timeouts = seat.timeouts;
      existing.connected = seat.connected;
      existing.isBot = seat.isBot;
      existing.botPolicy = seat.botPolicy ?? "";
    }

    state.coins.splice(0, state.coins.length);
    for (const coin of snapshot.coins) {
      const created = new CarromCoinState();
      created.id = coin.id;
      created.colour = coin.colour;
      created.x = coin.x;
      created.y = coin.y;
      state.coins.push(created);
    }
  }
}

/** True when the seat options name the same seats, in the same order. */
export function seatsMatchOptions(
  seats: readonly RunnerSeat[],
  options: readonly z.infer<typeof seatOptionSchema>[],
): boolean {
  if (seats.length !== options.length) {
    return false;
  }

  return seats.every((seat, index) => {
    const option = options[index];
    if (option === undefined) {
      return false;
    }
    if (option.kind === "human") {
      return !seat.isBot && seat.playerId === option.playerId;
    }
    return seat.isBot && seat.botLevel === (option.level as BotLevel);
  });
}

export type { MatchResult, ShotBroadcast };
