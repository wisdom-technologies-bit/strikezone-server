import { createServer } from "node:http";
import { Server as ColyseusServer } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createApp } from "./app.js";
import { subscribeSettlement } from "./betting/settle.js";
import { env } from "./lib/env.js";
import { matchRepository } from "./lib/match-store.js";
import { marketsRepository } from "./odds/markets-store.js";
import { logger } from "./lib/logger.js";
import { isOriginAllowed } from "./lib/origins.js";
import { DEFAULT_DRAIN_TIMEOUT_MS, registerShutdownHandlers } from "./lib/shutdown.js";
import { CarromRoom } from "./rooms/carrom-room.js";
import { tournamentRepository } from "./tournaments/repository.js";
import { SupabaseSchedulerLease, TournamentScheduler } from "./tournaments/scheduler.js";
import { tournamentService } from "./tournaments/index.js";

/**
 * Entry point: one HTTP server, one port.
 *
 * Express serves the HTTP API and Colyseus handles WebSocket upgrades on the
 * same `http.Server`, which is why PORT is shared by both.
 */
const app = createApp();
const httpServer = createServer(app);

const transport = new WebSocketTransport({
  server: httpServer,
  // Colyseus origin check: browsers always send Origin on the upgrade request.
  beforeUpgrade: (request) => {
    const origin = request.headers.get("origin");
    if (!isOriginAllowed(origin)) {
      logger.warn({ origin }, "rejected websocket upgrade from disallowed origin");
      return new Response("Forbidden origin", { status: 403 });
    }
    return undefined;
  },
});

const gameServer = new ColyseusServer({ transport, greet: false });

// One room type: a live carrom match. Only the server creates these, through
// POST /dev/start-match in development or matchmaking later; clients join by id.
gameServer.define("carrom", CarromRoom);

await gameServer.listen(env.PORT);

logger.info(
  {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    siteOrigin: env.SITE_ORIGIN,
    moneyMode: env.MONEY_MODE,
    currency: env.CURRENCY,
    houseMarginBps: env.HOUSE_MARGIN_BPS,
  },
  "strikezone-server listening",
);

/**
 * The tournament scheduler.
 *
 * It resumes first, which is the same code as a tick: whatever was left running
 * when this process (or the one before it) stopped is picked up from the
 * database, not from memory. The interval is ten seconds and never keeps the
 * process alive on its own.
 */
const scheduler = new TournamentScheduler({
  repository: tournamentRepository(),
  service: tournamentService(),
  lease: new SupabaseSchedulerLease(),
});

void scheduler.resume().catch((error: unknown) => {
  logger.error({ err: error }, "could not resume the tournament scheduler");
});
scheduler.start();

/**
 * Settlement is event driven.
 *
 * The room publishes `markets.ready_to_settle` when a match ends, and the
 * betting layer verifies the match and settles its bets. The handler is
 * idempotent, so a failed run is safe to repeat; `settleMatch` can also be
 * called by hand for a match that was missed while the process was down.
 */
const unsubscribeSettlement = subscribeSettlement({
  matches: matchRepository(),
  markets: marketsRepository(),
});

registerShutdownHandlers({
  onDrain: unsubscribeSettlement,
  gameServer,
  httpServer,
  logger,
  timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
});
