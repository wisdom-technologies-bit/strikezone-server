import type { Server as HttpServer } from "node:http";
import { matchMaker } from "colyseus";
import { beginShutdown, isShuttingDown } from "./lifecycle.js";
import type { Logger } from "pino";

/**
 * Graceful shutdown (AI_RULES.md: stop accepting new rooms, let running matches
 * finish for up to 30 seconds, then exit).
 *
 * 1. Mark the process as shutting down, so rooms and routes refuse new work.
 * 2. Close the HTTP server: no new TCP connections, therefore no new HTTP
 *    requests, matchmaking calls or WebSocket upgrades. Established sockets stay
 *    alive, which is what lets a match in progress finish.
 * 3. Poll matchmaking until no room is left, or the drain deadline passes.
 * 4. Tear Colyseus down (transport, presence, driver) and stop watching signals.
 */

export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

const DRAIN_POLL_INTERVAL_MS = 250;

export interface StopServerOptions {
  readonly gameServer: { gracefullyShutdown: (exit?: boolean) => Promise<void> };
  readonly httpServer: HttpServer;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** Stops background subscribers before the sockets close. */
  readonly onDrain?: () => void;
}

async function countActiveRooms(): Promise<number> {
  try {
    const rooms = await matchMaker.query({});
    return rooms.length;
  } catch {
    // A driver that cannot be queried is treated as drained so shutdown never hangs.
    return 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits until matchmaking reports no rooms, or the deadline passes. */
async function drainRooms(logger: Logger, timeoutMs: number): Promise<"drained" | "timed_out"> {
  const deadline = Date.now() + timeoutMs;
  let remaining = await countActiveRooms();

  while (remaining > 0 && Date.now() < deadline) {
    logger.info({ remaining }, "waiting for running matches to finish");
    await delay(Math.min(DRAIN_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    remaining = await countActiveRooms();
  }

  return remaining === 0 ? "drained" : "timed_out";
}

/**
 * Runs the shutdown sequence once per process.
 *
 * @returns `true` when every match finished before the deadline, `false` when
 * the drain timed out and the remaining rooms were closed.
 */
export async function stopServer(options: StopServerOptions): Promise<boolean> {
  const { gameServer, httpServer, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  beginShutdown();

  try {
    options.onDrain?.();
  } catch (error) {
    options.logger.warn({ err: error }, "a drain hook failed");
  }
  logger.info({ timeoutMs }, "shutdown requested: refusing new rooms and connections");

  await new Promise<void>((resolve) => {
    httpServer.close(() => {
      resolve();
    });
    // Do not wait for keep-alive sockets: the drain below owns the deadline.
    resolve();
  });

  const outcome = await drainRooms(logger, timeoutMs);

  try {
    await gameServer.gracefullyShutdown(false);
  } catch (error) {
    logger.error({ err: error }, "error while closing colyseus");
  }

  if (outcome === "timed_out") {
    logger.warn({ timeoutMs }, "drain deadline reached; closing remaining rooms");
    return false;
  }

  logger.info("shutdown complete");
  return true;
}

export interface ShutdownHandle {
  /** Runs the shutdown sequence once; later calls return the same promise. */
  shutdown: (signal: string) => Promise<void>;
  /** True once a shutdown has been requested. */
  readonly requested: () => boolean;
}

/**
 * Wires SIGTERM and SIGINT to {@link stopServer}, then exits the process.
 *
 * Exit code is 0 when every match finished and 1 when the drain deadline forced
 * the shutdown, so an orchestrator can tell the two apart.
 */
export function registerShutdownHandlers(options: StopServerOptions): ShutdownHandle {
  let pending: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    if (pending !== undefined) {
      options.logger.warn({ signal }, "shutdown already in progress");
      return pending;
    }

    options.logger.info({ signal }, "signal received");
    pending = stopServer(options)
      .then((drained) => {
        options.logger.info({ drained }, "process exiting");
        process.exit(drained ? 0 : 1);
      })
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "shutdown failed");
        process.exit(1);
      });

    return pending;
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  return { shutdown, requested: isShuttingDown };
}
