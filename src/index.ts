import { createServer } from "node:http";
import { Server as ColyseusServer } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createApp } from "./app.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { isOriginAllowed } from "./lib/origins.js";
import { DEFAULT_DRAIN_TIMEOUT_MS, registerShutdownHandlers } from "./lib/shutdown.js";

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

// Rooms are defined here in later tasks; no game logic exists yet.
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

registerShutdownHandlers({
  gameServer,
  httpServer,
  logger,
  timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
});
