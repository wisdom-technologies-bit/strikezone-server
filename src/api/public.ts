import { Router, type RequestHandler } from "express";
import { z } from "zod";
import {
  CONTRACT_VERSION,
  leaderboardQuerySchema,
  matchesQuerySchema,
  pageQuerySchema,
} from "./contract.js";
import { requireUser, userOf, type VerifyUser } from "./auth.js";
import { env } from "../lib/env.js";
import { RateLimiter } from "../lib/rate-limit.js";
import { logger } from "../lib/logger.js";
import { publicQueries } from "../public/queries.js";

/**
 * The public API.
 *
 * Three things happen to every public read before a handler sees it, and they all
 * live in this file so there is one place to look when a cache is stale or a
 * client is being throttled:
 *
 * - **Ip rate limiting**, from configuration, so a scraper cannot cost more than
 *   a page of reads a minute.
 * - **A two second cache**, because a leaderboard does not change between two
 *   page loads and the odds engine does not need this traffic at all. The cache
 *   is per process and keyed by the full URL, so `/api/matches/:id` and
 *   `/api/matches/:id?x=1` never share an entry.
 * - **Validation**, before any query runs: a bad `limit` is a 400, not a slow
 *   query.
 *
 * The signed-in routes (`/api/me/*`) are never cached and never shared: they are
 * mounted on the same router but behind the user middleware, and the cache
 * refuses a request that carries an Authorization header outright.
 */

/** The default lifetime of a cached public response. */
export const PUBLIC_CACHE_MS = 2_000;

/** Most responses the cache will hold. */
const CACHE_ENTRIES = 512;

interface Cached {
  readonly status: number;
  readonly body: unknown;
  readonly storedAt: number;
}

/** A tiny TTL cache for JSON responses. */
export class ResponseCache {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Cached>();

  constructor(ttlMs: number = PUBLIC_CACHE_MS, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get(key: string): Cached | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (this.#now() - entry.storedAt >= this.#ttlMs) {
      this.#entries.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, status: number, body: unknown): void {
    if (this.#entries.size >= CACHE_ENTRIES) {
      // Oldest first: a Map keeps insertion order, so this is the oldest key.
      const oldest = this.#entries.keys().next();
      if (!oldest.done) {
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(key, { status, body, storedAt: this.#now() });
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

export interface PublicMiddlewareOptions {
  readonly cacheTtlMs?: number;
  readonly ratePerMinute?: number;
  readonly now?: () => number;
}

/**
 * The cache, as a middleware.
 *
 * It only ever stores a 200 from a GET that carried no Authorization header, and
 * it marks the response with `Cache-Control` so a CDN in front of the server can
 * make the same decision.
 */
export function createPublicCache(options: PublicMiddlewareOptions = {}): RequestHandler {
  const cache = new ResponseCache(options.cacheTtlMs ?? PUBLIC_CACHE_MS, options.now);

  return (request, response, next) => {
    if (
      request.method !== "GET" ||
      request.headers.authorization !== undefined ||
      isPrivatePath(request.path)
    ) {
      next();
      return;
    }

    const key = request.originalUrl;
    const hit = cache.get(key);
    if (hit !== null) {
      response.setHeader("x-cache", "hit");
      response.setHeader("cache-control", "public, max-age=2");
      response.status(hit.status).json(hit.body);
      return;
    }

    const originalJson = response.json.bind(response);
    response.json = ((body: unknown) => {
      if (response.statusCode === 200) {
        cache.set(key, 200, body);
      }
      response.setHeader("x-cache", "miss");
      response.setHeader("cache-control", "public, max-age=2");
      return originalJson(body);
    }) as typeof response.json;

    next();
  };
}

/** The per-IP limiter. A refusal says how long to wait. */
export function createPublicRateLimit(options: PublicMiddlewareOptions = {}): RequestHandler {
  const limiter = new RateLimiter(
    options.ratePerMinute ?? env.PUBLIC_API_RATE_PER_MINUTE,
    options.now,
  );

  return (request, response, next) => {
    if (isPrivatePath(request.path)) {
      next();
      return;
    }

    const key = request.ip ?? "unknown";
    if (!limiter.take(key)) {
      response.setHeader("retry-after", String(limiter.retryAfterSeconds(key)));
      response.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }
    next();
  };
}

/**
 * Paths the public cache and limiter must not touch: operator reads are neither
 * shared nor rate limited like a player's, and a development route is not public.
 */
function isPrivatePath(path: string): boolean {
  return path.startsWith("/api/admin") || path.startsWith("/api/dev") || path.startsWith("/dev");
}

/** Turns a zod failure into the one error shape the contract defines. */
function invalid(response: Parameters<RequestHandler>[1], error: z.ZodError): void {
  response.status(400).json({
    ok: false,
    error: "invalid_request",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export interface PublicRouterOptions {
  readonly verifyUser?: VerifyUser;
}

/**
 * The routes.
 *
 * `markets` and the tournament list are served elsewhere (they were built with
 * the odds engine and the tournament runner); this router covers the reads that
 * did not exist yet, and the signed-in player's own wallet.
 */
export function createPublicRouter(options: PublicRouterOptions = {}): Router {
  const router = Router();
  const queries = publicQueries();

  router.get("/api/config", (_request, response) => {
    const config = queries.config();
    response.status(200).json({
      ok: true,
      ...config,
      contractVersion: CONTRACT_VERSION,
    });
  });

  for (const kind of ["live", "upcoming", "recent"] as const) {
    router.get(`/api/matches/${kind}`, async (request, response, next) => {
      const parsed = matchesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        invalid(response, parsed.error);
        return;
      }

      try {
        const page = await queries.matches(kind, parsed.data);
        response.status(200).json({ ok: true, ...page });
      } catch (error) {
        next(error);
      }
    });
  }

  const idParams = z.strictObject({ id: z.string().uuid() });

  router.get("/api/matches/:id", async (request, response, next) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      invalid(response, params.error);
      return;
    }

    try {
      const match = await queries.match(params.data.id);
      if (match === null) {
        response.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      response.status(200).json({ ok: true, match });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/players/:id", async (request, response, next) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      invalid(response, params.error);
      return;
    }

    try {
      const player = await queries.player(params.data.id);
      if (player === null) {
        response.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      response.status(200).json({ ok: true, player });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/leaderboard", async (request, response, next) => {
    const parsed = leaderboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      invalid(response, parsed.error);
      return;
    }

    try {
      const entries = await queries.leaderboard(parsed.data);
      response.status(200).json({ ok: true, entries });
    } catch (error) {
      next(error);
    }
  });

  const player = requireUser(
    options.verifyUser === undefined ? undefined : { verifyUser: options.verifyUser },
  );

  router.get("/api/me/wallet", player, async (_request, response, next) => {
    try {
      const wallet = await queries.wallet(userOf(response).id);
      response.status(200).json({ ok: true, ...wallet });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/me/transactions", player, async (request, response, next) => {
    const parsed = pageQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      invalid(response, parsed.error);
      return;
    }

    try {
      const page = await queries.transactions(userOf(response).id, parsed.data);
      response.status(200).json({ ok: true, ...page });
    } catch (error) {
      next(error);
    }
  });

  // A refused read is worth knowing about: it is either a bug or an attack.
  router.use((error: unknown, request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => {
    logger.warn({ err: error, path: request.path }, "public read failed");
    void next;
    response.status(503).json({ ok: false, error: "read_unavailable" });
  });

  return router;
}

/** Where the cache and the limiter are mounted, for the app and for tests. */
export function createPublicGuards(options: PublicMiddlewareOptions = {}): readonly RequestHandler[] {
  return [createPublicRateLimit(options), createPublicCache(options)];
}
