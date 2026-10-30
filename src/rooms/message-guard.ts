import { env } from "../lib/env.js";

/**
 * What a room accepts from one client, before it reads the message.
 *
 * Colyseus hands the room whatever the client sent. Two failures follow from
 * trusting that blindly: a message larger than the game's own moves costs the
 * process real memory to parse, and a client that sends a thousand of them a
 * second takes the room's turn loop away from everybody else. Both are cheap to
 * refuse here, before Zod and before the runner sees anything.
 *
 * The limits are per process, from the environment: MAX_MESSAGE_BYTES and
 * MAX_MESSAGES_PER_SECOND.
 */

export type MessageVerdict = "ok" | "too_large" | "too_fast";

export interface MessageGuard {
  /** Judges one message from one client. Never throws. */
  check(clientId: string, raw: unknown): MessageVerdict;
  /** How many messages one client was refused in the last minute. */
  violations(clientId: string): number;
}

/** The window a rate is measured over. */
const WINDOW_MS = 1_000;

/** Refusals inside a minute after which the room should hang up. */
export const VIOLATIONS_BEFORE_LEAVE = 5;

/**
 * The size of a message in bytes.
 *
 * Measured on the serialised form because that is what arrived over the wire, and
 * a string is measured as itself rather than as a JSON string, so a large
 * hand-rolled payload is not under-counted.
 */
export function messageBytes(raw: unknown): number {
  if (typeof raw === "string") {
    return Buffer.byteLength(raw, "utf8");
  }
  try {
    return Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    // A payload that will not serialise is not one this server can honour.
    return Number.POSITIVE_INFINITY;
  }
}

/** A guard with the process's configured limits. */
export function createMessageGuard(
  options: {
    readonly maxBytes?: number;
    readonly maxPerSecond?: number;
    readonly now?: () => number;
  } = {},
): MessageGuard {
  const maxBytes = options.maxBytes ?? env.MAX_MESSAGE_BYTES;
  const maxPerSecond = options.maxPerSecond ?? env.MAX_MESSAGES_PER_SECOND;
  const now = options.now ?? (() => Date.now());

  const sent = new Map<string, number[]>();
  const refused = new Map<string, number[]>();

  return {
    check(clientId, raw) {
      const at = now();

      if (messageBytes(raw) > maxBytes) {
        const times = [...(refused.get(clientId) ?? []), at].filter((time) => at - time < 60_000);
        refused.set(clientId, times);
        return "too_large";
      }

      const recent = (sent.get(clientId) ?? []).filter((time) => at - time < WINDOW_MS);
      if (recent.length >= maxPerSecond) {
        sent.set(clientId, recent);
        const times = [...(refused.get(clientId) ?? []), at].filter((time) => at - time < 60_000);
        refused.set(clientId, times);
        return "too_fast";
      }

      recent.push(at);
      sent.set(clientId, recent);
      return "ok";
    },

    violations(clientId) {
      const at = now();
      return (refused.get(clientId) ?? []).filter((time) => at - time < 60_000).length;
    },
  };
}
