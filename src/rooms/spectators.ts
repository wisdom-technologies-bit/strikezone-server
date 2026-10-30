import type { EndMessage, ShotMessage, SnapshotMessage } from "../api/contract.js";
import { STREAM_MESSAGES } from "../api/contract.js";
import { env } from "../lib/env.js";
import { RateLimiter } from "../lib/rate-limit.js";
import { logger } from "../lib/logger.js";

/**
 * Spectators.
 *
 * A spectator is a read-only viewer: it receives the snapshot, then a message per
 * shot, and may send nothing. The thing that makes this module worth existing
 * rather than a `this.broadcast()` call is that a stream is a denial-of-service
 * surface. Three defences live here:
 *
 * 1. **A cap per room**, from configuration, so a viral match cannot exhaust the
 *    process.
 * 2. **A join rate per IP**, so one machine cannot take every seat.
 * 3. **Backpressure per viewer**: a spectator whose socket has more than
 *    `maxBufferedBytes` waiting is skipped rather than buffered. It is told it
 *    fell behind, and once its socket drains it gets one fresh snapshot instead
 *    of the frames it missed. Nobody's slow phone slows the room.
 *
 * The transport is injected, which is what lets the tests drive a viewer that
 * never reads.
 */

/** What a spectator may consume, and how quickly it may join. */
export interface SpectatorLimits {
  /** Most spectators in one room. */
  readonly maxPerRoom: number;
  /** Joins allowed from one IP in a rolling minute. */
  readonly joinsPerMinute: number;
  /** A viewer with more than this waiting is skipped until it drains. */
  readonly maxBufferedBytes: number;
}

/** Defaults, so a room needs no configuration to be safe. */
export const DEFAULT_SPECTATOR_LIMITS: SpectatorLimits = {
  maxPerRoom: 2000,
  joinsPerMinute: 60,
  maxBufferedBytes: 1_048_576,
};

/** Reads the limits from the environment, falling back to the defaults. */
export function spectatorLimitsFromEnv(): SpectatorLimits {
  return {
    maxPerRoom: env.MAX_SPECTATORS_PER_ROOM,
    joinsPerMinute: env.SPECTATOR_JOIN_PER_MINUTE,
    maxBufferedBytes: DEFAULT_SPECTATOR_LIMITS.maxBufferedBytes,
  };
}

/** How the hub reaches a client. In a room this wraps `client.send`. */
export interface SpectatorTransport {
  send(sessionId: string, type: string, payload: unknown): void;
  /** Bytes waiting in that client's socket buffer. Zero when unknown. */
  bufferedBytes(sessionId: string): number;
}

/** A join refused at the door. Carries a code the caller can map to a close code. */
export class SpectatorRefused extends Error {
  readonly code: "room_full" | "rate_limited";

  constructor(code: "room_full" | "rate_limited", message: string) {
    super(message);
    this.name = "SpectatorRefused";
    this.code = code;
  }
}

interface Spectator {
  readonly ip: string;
  /** Shots skipped because the socket was behind. */
  skipped: number;
  /**
   * True until this viewer has its snapshot. A pending viewer is skipped by the
   * shot broadcast: it joined mid-shot, so the frames it would receive started
   * before it had any state to apply them to. Its snapshot arrives instead.
   */
  pending: boolean;
}

export interface SpectatorHubOptions {
  readonly limits?: SpectatorLimits;
  readonly transport: SpectatorTransport;
  readonly now?: () => number;
}

export class SpectatorHub {
  readonly #limits: SpectatorLimits;
  readonly #transport: SpectatorTransport;
  readonly #limiter: RateLimiter;
  readonly #spectators = new Map<string, Spectator>();

  constructor(options: SpectatorHubOptions) {
    this.#limits = options.limits ?? DEFAULT_SPECTATOR_LIMITS;
    this.#transport = options.transport;
    this.#limiter = new RateLimiter(
      options.limits?.joinsPerMinute ?? this.#limits.joinsPerMinute,
      options.now,
    );
  }

  get count(): number {
    return this.#spectators.size;
  }

  /** The most spectators this hub will hold. */
  get capacity(): number {
    return this.#limits.maxPerRoom;
  }

  /** True when this session is a spectator. */
  has(sessionId: string): boolean {
    return this.#spectators.has(sessionId);
  }

  /**
   * Registers a spectator, or throws {@link SpectatorRefused}.
   *
   * The rate limit is checked before the cap: a flood from one machine must not
   * be able to fill the last seats before the other defenders see it.
   */
  add(sessionId: string, ip: string): void {
    if (!this.#limiter.take(ip)) {
      throw new SpectatorRefused("rate_limited", "too many spectator joins from this address");
    }
    if (this.#spectators.size >= this.#limits.maxPerRoom) {
      throw new SpectatorRefused("room_full", "this room has no spectator seats left");
    }
    this.#spectators.set(sessionId, { ip, skipped: 0, pending: true });
  }

  remove(sessionId: string): void {
    this.#spectators.delete(sessionId);
  }

  /** Sends one message to one spectator, with no backpressure check. */
  sendTo(sessionId: string, type: string, payload: unknown): void {
    this.#transport.send(sessionId, type, payload);
  }

  /**
   * The full state, for a viewer that has just arrived or has fallen behind.
   *
   * Delivering a snapshot is what makes a viewer live: before it, the viewer is
   * skipped by the broadcast, so no frames can arrive ahead of the state they
   * belong to.
   */
  sendSnapshot(sessionId: string, snapshot: SnapshotMessage): void {
    this.sendState(sessionId, STREAM_MESSAGES.snapshot, snapshot);
  }

  /**
   * Delivers whatever a viewer needs to be live, and makes it live.
   *
   * Carrom's snapshot and Ludo's are different shapes, so this takes the message
   * type: what matters to the hub is that the viewer has state and may now receive
   * frames, not what the state looks like.
   */
  sendState(sessionId: string, type: string, payload: unknown): void {
    const spectator = this.#spectators.get(sessionId);
    if (spectator === undefined) {
      return;
    }
    spectator.pending = false;
    this.#transport.send(sessionId, type, payload);
  }

  /**
   * Fans one shot out to every spectator that can take it.
   *
   * A viewer whose buffer is over the cap is skipped: the shot is not queued for
   * it, so a stuck phone cannot grow the server's memory or delay the others.
   */
  broadcastShot(message: ShotMessage): void {
    for (const [sessionId, spectator] of this.#spectators) {
      if (spectator.pending) {
        continue;
      }

      if (this.#transport.bufferedBytes(sessionId) > this.#limits.maxBufferedBytes) {
        spectator.skipped += 1;
        continue;
      }

      this.#transport.send(sessionId, STREAM_MESSAGES.shot, message);

      if (spectator.skipped > 0) {
        // The socket recovered. Rather than replay the missed shots, say how many
        // were missed and hand over a snapshot: one message, no stale motion.
        this.#transport.send(sessionId, STREAM_MESSAGES.lag, {
          type: "lag",
          skippedShots: spectator.skipped,
          reason: "slow_consumer",
        });
        spectator.skipped = 0;
      }
    }
  }

  /**
   * Sends one message to every live spectator.
   *
   * The same backpressure rule as {@link broadcastShot}: a viewer whose socket is
   * behind is skipped, not queued for. Ludo uses this for its roll and move
   * messages, which are small but just as unbounded in number.
   */
  broadcast(type: string, payload: unknown): void {
    for (const [sessionId, spectator] of this.#spectators) {
      if (spectator.pending) {
        continue;
      }
      if (this.#transport.bufferedBytes(sessionId) > this.#limits.maxBufferedBytes) {
        spectator.skipped += 1;
        continue;
      }
      this.#transport.send(sessionId, type, payload);
    }
  }

  /** Tells everyone the match is over. Best effort: a viewer may be gone. */
  broadcastEnd(end: EndMessage): void {
    for (const sessionId of this.#spectators.keys()) {
      this.#transport.send(sessionId, STREAM_MESSAGES.end, end);
    }
  }

  /** Spectators that are currently being skipped, for logging. */
  lagging(): number {
    let count = 0;
    for (const spectator of this.#spectators.values()) {
      if (spectator.skipped > 0) {
        count += 1;
      }
    }
    return count;
  }

  warnIfLagging(matchId: string): void {
    const lagging = this.lagging();
    if (lagging > 0) {
      logger.warn({ matchId, lagging }, "spectators are behind and their frames are being skipped");
    }
  }
}
