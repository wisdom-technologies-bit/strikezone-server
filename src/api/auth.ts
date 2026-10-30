import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { raiseAlert } from "../monitoring/alerts.js";
import { adminStore } from "../admin/store.js";

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

/** One IP's recent failures against the admin gate. */
interface LockoutEntry {
  failures: number;
  blockedUntil: number;
}

const lockouts = new Map<string, LockoutEntry>();

/** The state of one IP, for the tests and for a health report. */
export function adminLockoutState(ip: string): Readonly<LockoutEntry> | null {
  return lockouts.get(ip) ?? null;
}

/** Clears every lockout. Tests only: a restart is not a security control. */
export function resetAdminLockouts(): void {
  lockouts.clear();
}

/**
 * The admin gate.
 *
 * Three rules, because this key is the only thing between the internet and the
 * house's money.
 *
 * 1. The comparison is constant time over fixed-length digests, so neither the
 *    content nor the length of the key leaks through timing.
 * 2. Ten wrong keys from one address lock that address out for a quarter of an
 *    hour, and the lockout itself raises an alert. A shared key that can be
 *    guessed at leisure is not a key.
 * 3. Every call is written to the audit trail once it has finished, with the
 *    path, the status, the actor and the request id, whether it succeeded or not.
 */
export const requireAdmin: RequestHandler = (request, response, next) => {
  const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const state = lockouts.get(ip);

  if (state !== undefined && state.blockedUntil > now) {
    logger.warn({ ip, path: request.path }, "admin gate is locked out for this address");
    response.status(429).json({ ok: false, error: "locked_out" });
    return;
  }

  const provided = request.headers["x-admin-key"];
  const key = Array.isArray(provided) ? provided[0] : provided;

  if (typeof key !== "string" || !constantTimeEquals(key, env.ADMIN_API_KEY)) {
    const failures = (state?.failures ?? 0) + 1;
    const blockedUntil = failures >= env.ADMIN_LOCKOUT_THRESHOLD ? now + env.ADMIN_LOCKOUT_MS : 0;
    lockouts.set(ip, { failures, blockedUntil });

    logger.warn({ ip, path: request.path, failures }, "wrong admin key");

    if (blockedUntil > 0) {
      void raiseAlert({
        code: "admin_lockout",
        severity: "critical",
        message: `admin gate locked out ${ip} after ${String(failures)} wrong keys`,
        context: { ip, failures, path: request.path },
      });
      response.status(429).json({ ok: false, error: "locked_out" });
      return;
    }

    response.status(403).json({ ok: false, error: "admin_only" });
    return;
  }

  if (state !== undefined) {
    lockouts.delete(ip);
  }

  const actorHeader = request.headers["x-admin-actor"];
  const actorName = Array.isArray(actorHeader) ? actorHeader[0] : actorHeader;
  const actor =
    typeof actorName === "string" && actorName.trim() !== "" ? actorName.trim() : "admin";
  response.locals["adminActor"] = actor;

  // The audit row is written after the response, so it records what happened
  // rather than what was attempted. A failure to write it is loud: an operator
  // call that left no trace is exactly what the trail exists to prevent.
  response.on("finish", () => {
    const requestId = response.locals["requestId"];
    void adminStore()
      .recordAction({
        action: `${request.method} ${request.path}`,
        targetType: "admin_api",
        targetId: null,
        payload: {
          status: response.statusCode,
          ip,
          requestId: typeof requestId === "string" ? requestId : null,
        },
        actor,
        at: new Date().toISOString(),
      })
      .catch((error: unknown) => {
        logger.error({ err: error, path: request.path }, "could not write the admin audit row");
      });
  });

  next();
};

/** Compares two strings without leaking their length or their content. */
export function constantTimeEquals(left: string, right: string): boolean {
  // Hashing first makes the buffers the same length whatever was sent, so the
  // comparison is over 32 bytes and the length of the key is not an oracle.
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
