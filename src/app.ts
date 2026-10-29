import express, { type ErrorRequestHandler, type Express } from "express";
import cors, { type CorsOptions } from "cors";
import { healthRouter } from "./api/health.js";
import { readyRouter } from "./api/ready.js";
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

  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter);
  app.use(readyRouter);

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
