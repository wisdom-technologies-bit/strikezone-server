import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";

/**
 * Who is asking.
 *
 * Two kinds of caller touch the tournament API:
 *
 * - A **player**, who sends their Supabase access token as `Authorization: Bearer
 *   <jwt>`. It is checked with `supabase.auth.getUser`, so a forged or expired
 *   token never reaches a handler.
 * - An **operator**, who sends `x-admin-key`. The comparison is constant time, so
 *   the endpoint cannot be used to guess the key one byte at a time.
 */

/** The user behind a request, once authenticated. */
export interface AuthUser {
  readonly id: string;
  /** What to call them. Falls back to the local part of their email. */
  readonly displayName: string;
}

/** Resolves a token to a user, or null. Injectable so tests need no Supabase. */
export type VerifyUser = (token: string) => Promise<AuthUser | null>;

const defaultVerifyUser: VerifyUser = async (token) => {
  const { data, error } = await supabase.auth.getUser(token);
  if (error !== null || data.user === null) {
    return null;
  }

  const metadata: unknown = data.user.user_metadata;
  const fullName =
    typeof metadata === "object" && metadata !== null && "full_name" in metadata
      ? String((metadata as Record<string, unknown>)["full_name"] ?? "")
      : "";
  const fallback = data.user.email?.split("@")[0] ?? "Player";

  return { id: data.user.id, displayName: fullName.trim() === "" ? fallback : fullName };
};

/** The middleware that puts a player on `response.locals.user`, or refuses. */
export function requireUser(options?: { readonly verifyUser?: VerifyUser }): RequestHandler {
  const verifyUser = options?.verifyUser ?? defaultVerifyUser;

  return (request, response, next) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") === true ? header.slice(7).trim() : "";

    if (token === "") {
      response.status(401).json({ ok: false, error: "missing_token" });
      return;
    }

    void verifyUser(token)
      .then((user) => {
        if (user === null) {
          response.status(401).json({ ok: false, error: "invalid_token" });
          return;
        }
        response.locals["user"] = user;
        next();
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "could not verify the access token");
        response.status(503).json({ ok: false, error: "auth_unavailable" });
      });
  };
}

/** The user on a request that passed `requireUser`. */
export function userOf(response: { locals: Record<string, unknown> }): AuthUser {
  const user = response.locals["user"];
  if (typeof user !== "object" || user === null) {
    throw new Error("userOf called on a request without a user");
  }
  return user as AuthUser;
}

/** The admin gate: `x-admin-key` must equal ADMIN_API_KEY exactly. */
export const requireAdmin: RequestHandler = (request, response, next) => {
  const provided = request.headers["x-admin-key"];
  const key = Array.isArray(provided) ? provided[0] : provided;

  if (typeof key !== "string" || !constantTimeEquals(key, env.ADMIN_API_KEY)) {
    response.status(403).json({ ok: false, error: "admin_only" });
    return;
  }

  next();
};

/** Compares two strings without leaking their length or their content. */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
