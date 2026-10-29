import { Router } from "express";
import { checkSupabaseConnection } from "../lib/supabase.js";
import { isShuttingDown } from "../lib/lifecycle.js";

/**
 * Readiness probe: GET /ready
 *
 * 200 only when this instance can actually serve traffic: not draining and the
 * Supabase connection test passes. 503 otherwise, so a load balancer stops
 * sending new matches here while running ones finish.
 */
export const readyRouter: Router = Router();

readyRouter.get("/ready", async (_request, response) => {
  if (isShuttingDown()) {
    response.status(503).json({
      ok: false,
      checks: { draining: "down", supabase: "unknown" },
    });
    return;
  }

  const supabaseCheck = await checkSupabaseConnection();

  if (!supabaseCheck.ok) {
    response.status(503).json({
      ok: false,
      checks: { draining: "up", supabase: "down" },
      detail: supabaseCheck.detail,
    });
    return;
  }

  response.status(200).json({
    ok: true,
    checks: { draining: "up", supabase: "up" },
  });
});
