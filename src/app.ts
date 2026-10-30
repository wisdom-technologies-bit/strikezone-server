import express, { type ErrorRequestHandler, type Express } from "express";
import cors, { type CorsOptions } from "cors";
import { monitor } from "@colyseus/monitor";
import { createAdminMoneyRouter } from "./api/admin-money.js";
import { createAdminTournamentsRouter } from "./api/admin-tournaments.js";
import { createBetsRouter } from "./api/bets.js";
import { createPaymentsRouter } from "./api/payments.js";
import { botsRouter } from "./api/bots.js";
import { createTournamentsRouter } from "./api/tournaments.js";
import { createDevRouter } from "./api/dev.js";
import { healthRouter } from "./api/health.js";
import { createMarketsRouter } from "./api/markets.js";
import { matchesRouter } from "./api/matches.js";
import { readyRouter } from "./api/ready.js";
import { env } from "./lib/env.js";
import { isOriginAllowed } from "./lib/origins.js";
import { logger } from "./lib/logger.js";

/**
 * Builds the Express application.
 *
 * The same HTTP server hosts these routes and the Colyseus WebSocket endpoint,
 * so this app is created here and handed to `createServer()` in src/index.ts.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");

  /**
   * Origin gate.
   *
   * Colyseus binds its own request hook to the shared server and reflects the
   * request Origin into `Access-Control-Allow-Origin` for its matchmaking
   * routes. Our allowlist has to win, so any request carrying a different
   * origin is refused here and the reflected headers are removed first.
   */
  app.use((request, response, next) => {
    const origin = request.headers.origin;

    if (isOriginAllowed(origin)) {
      next();
      return;
    }

    logger.warn({ origin, path: request.path }, "rejected request from disallowed origin");
    response.removeHeader("access-control-allow-origin");
    response.removeHeader("access-control-allow-credentials");
    response.status(403).json({ ok: false, error: "origin_not_allowed" });
  });

  const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
  };
  app.use(cors(corsOptions));

  /**
   * The raw body is kept as well as the parsed one: a payment webhook's signature
   * covers the exact bytes the provider sent, and re-serialising the parsed object
   * would not authenticate it.
   */
  app.use(
    express.json({
      limit: "100kb",
      verify: (request, _response, buffer) => {
        (request as { rawBody?: string }).rawBody = buffer.toString("utf8");
      },
    }),
  );

  app.use(healthRouter);
  app.use(readyRouter);
  app.use(botsRouter);
  app.use(matchesRouter);
  app.use(createMarketsRouter());
  app.use(createBetsRouter());
  app.use(createPaymentsRouter());
  app.use(createAdminMoneyRouter());
  app.use(createTournamentsRouter());
  app.use(createAdminTournamentsRouter());

  /**
   * Development only: the bot match starter, and Colyseus's monitor so the rooms
   * and their state can be watched in a browser. Neither is mounted in test or
   * production, so the route does not exist there at all.
   */
  if (env.NODE_ENV === "development") {
    app.use(createDevRouter());
    app.use("/colyseus", monitor());
  }

  app.use((_request, response) => {
    response.status(404).json({ ok: false, error: "not_found" });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    logger.error({ err: error }, "unhandled request error");
    response.status(500).json({ ok: false, error: "internal_error" });
  };
  app.use(errorHandler);

  return app;
}
