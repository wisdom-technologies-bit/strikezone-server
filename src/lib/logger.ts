import { pino, type Logger } from "pino";
import { env } from "./env.js";

/**
 * Structured logging with defensive redaction.
 *
 * pino's own `redact` option only understands explicit paths, so on top of it
 * every log object is walked and any key that looks sensitive (secret, key,
 * token, password, ...) is replaced before the line is written. Belt and braces:
 * a secret should never be logged in the first place (AI_RULES.md hard rule 5).
 */

const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN = /(secret|key|token|password|authorization|cookie|signature)/i;

function redactKeys(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactKeys(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    // Errors are passed through so pino's error serializer keeps stack traces intact.
    if (value instanceof Error) {
      return value;
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactKeys(entry, depth + 1);
    }
    return result;
  }
  return value;
}

function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactKeys(object) as Record<string, unknown>;
}

const isDevelopment = env.NODE_ENV === "development";

export const logger: Logger = pino({
  level: isDevelopment ? "debug" : "info",
  base: { service: "strikezone-server", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.secret",
      "*.key",
      "*.token",
      "*.password",
      "*.*.secret",
      "*.*.key",
      "*.*.token",
      "*.*.password",
    ],
    censor: REDACTED,
  },
  formatters: {
    log: redactLogObject,
  },
  ...(isDevelopment
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname,service,env",
          },
        },
      }
    : {}),
});
