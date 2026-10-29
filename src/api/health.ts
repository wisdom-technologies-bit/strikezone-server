import { Router } from "express";
import { APP_VERSION } from "../lib/version.js";

/**
 * Liveness probe: GET /health
 *
 * Answers as long as the process is running and can serve HTTP. It never touches
 * the database, so a database outage must not restart a healthy process.
 */
export const healthRouter: Router = Router();

healthRouter.get("/health", (_request, response) => {
  response.status(200).json({
    ok: true,
    version: APP_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});
