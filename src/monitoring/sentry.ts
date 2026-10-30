import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

/**
 * Sentry, if it is installed and configured.
 *
 * Two conditions, both silent by design. Without a DSN nothing is imported and
 * nothing is logged; without the package installed the import is skipped and a
 * single line says so at startup. A server whose error reporting is optional must
 * not fail to start because the reporter is missing.
 */

/** The little of Sentry's API this module uses. */
interface SentryLike {
  init?: (options: { readonly dsn: string; readonly environment: string }) => void;
  captureException?: (error: unknown) => void;
}

let sentry: SentryLike | null = null;

/** Loads Sentry when a DSN is set. Returns whether reporting is live. */
export async function initSentry(): Promise<boolean> {
  const dsn = env.SENTRY_DSN;
  if (dsn === undefined || dsn === "") {
    return false;
  }

  try {
    // A variable specifier, so the build does not require the package to exist.
    const specifier = "@sentry/node";
    const loaded: unknown = await import(specifier);
    const candidate = (loaded as { default?: SentryLike }).default ?? (loaded as SentryLike);
    candidate.init?.({ dsn, environment: env.NODE_ENV });
    sentry = candidate;
    logger.info({}, "sentry error reporting is on");
    return true;
  } catch {
    logger.warn({}, "SENTRY_DSN is set but @sentry/node is not installed: reporting is off");
    return false;
  }
}

/** Reports an error, when reporting is live. Never throws. */
export function captureError(error: unknown): void {
  try {
    sentry?.captureException?.(error);
  } catch {
    // A reporter that throws is not worth a second failure.
  }
}
