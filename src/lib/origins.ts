import { env } from "./env.js";

/**
 * The origin allowlist used by CORS and by the Colyseus WebSocket origin check.
 *
 * Only SITE_ORIGIN is allowed, plus http://localhost:3000 while NODE_ENV is
 * development so the website can be developed locally against this server.
 */
export function allowedOrigins(): string[] {
  const origins = [normalizeOrigin(env.SITE_ORIGIN)];
  if (env.NODE_ENV === "development") {
    origins.push("http://localhost:3000");
  }
  return origins;
}

/**
 * Requests without an Origin header come from non-browser clients (curl, mobile
 * apps, server-to-server calls) and carry no cross-site risk, so they are
 * allowed. Browsers always send Origin, and an unknown one is rejected.
 */
export function isOriginAllowed(origin: string | undefined | null): boolean {
  if (origin === undefined || origin === null || origin === "") {
    return true;
  }
  return allowedOrigins().includes(normalizeOrigin(origin));
}

/** Reduces an origin to scheme + host + port so trailing slashes never cause a mismatch. */
function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}
