import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { env } from "./env.js";

/**
 * The tamper-evident match log.
 *
 * Every row of match_events carries `prev_hash` and `hash`, where
 *
 *   hash = SHA-256(prev_hash + canonicalJson({ seq, type, payload }))
 *
 * and the first row's `prev_hash` is the seed commitment published before play.
 * So the whole log hangs off the commitment: change one event, drop one, or
 * reorder them, and every later hash stops matching. The head of the chain is
 * stored on the match and signed together with the result, so a finished match's
 * outcome can be checked by anyone holding the revealed seed.
 */

/** One row of the match log. */
export interface MatchLogEntry {
  readonly seq: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly hash: string;
}

/** The hash of one entry, given the hash of the entry before it. */
export function entryHash(
  prevHash: string,
  seq: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(prevHash, "utf8")
    .update(canonicalJson({ seq, type, payload }), "utf8")
    .digest("hex");
}

/**
 * Appends entries one after another, starting from the seed commitment.
 *
 * Keeping the builder (rather than recomputing from the database) lets a room
 * write a batch of events knowing exactly what the chain head will be.
 */
export class MatchLogBuilder {
  readonly #entries: MatchLogEntry[] = [];
  #head: string;

  constructor(seedCommit: string) {
    if (seedCommit.length === 0) {
      throw new RangeError("the log needs a seed commitment to start from");
    }
    this.#head = seedCommit;
  }

  /** The hash the next entry will be chained from. */
  get head(): string {
    return this.#head;
  }

  /** The entries built so far, in order. */
  get entries(): readonly MatchLogEntry[] {
    return this.#entries;
  }

  /** Adds one entry and returns it. */
  append(type: string, payload: Readonly<Record<string, unknown>> = {}): MatchLogEntry {
    if (type.trim().length === 0) {
      throw new RangeError("a log entry needs a type");
    }

    const seq = this.#entries.length + 1;
    const hash = entryHash(this.#head, seq, type, payload);
    const entry: MatchLogEntry = { seq, type, payload, prevHash: this.#head, hash };

    this.#entries.push(entry);
    this.#head = hash;
    return entry;
  }
}

/** The outcome of checking a chain. */
export type ChainCheck =
  | { readonly ok: true; readonly head: string; readonly length: number }
  | { readonly ok: false; readonly reason: string; readonly seq: number | null };

/**
 * Recomputes a chain from its first entry's `prev_hash`.
 *
 * Checks that the sequence numbers are contiguous from 1, that every link matches,
 * and that the first link is the seed commitment when one is supplied.
 */
export function verifyLogChain(entries: readonly MatchLogEntry[], seedCommit?: string): ChainCheck {
  if (entries.length === 0) {
    return { ok: false, reason: "the match log is empty", seq: null };
  }

  let head = entries[0]?.prevHash ?? "";
  if (seedCommit !== undefined && head !== seedCommit) {
    return { ok: false, reason: "the first entry does not start from the seed commitment", seq: 1 };
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      return { ok: false, reason: "missing entry", seq: index + 1 };
    }

    const expectedSeq = index + 1;
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        reason: `expected seq ${expectedSeq}, found ${entry.seq}`,
        seq: entry.seq,
      };
    }
    if (entry.prevHash !== head) {
      return { ok: false, reason: "prev_hash does not match the previous entry", seq: entry.seq };
    }

    const expected = entryHash(entry.prevHash, entry.seq, entry.type, entry.payload);
    if (expected !== entry.hash) {
      return { ok: false, reason: "hash does not match its contents", seq: entry.seq };
    }

    head = entry.hash;
  }

  return { ok: true, head, length: entries.length };
}

/**
 * The signature over a finished match: HMAC-SHA256 with the server result signing
 * secret, over the canonical result plus the log head.
 *
 * Signing the head as well as the result is what ties the outcome to the event
 * log: a different log produces a different signature.
 */
export function signResult(
  result: unknown,
  logHeadHash: string,
  secret: string = env.RESULT_SIGNING_SECRET,
): string {
  return createHmac("sha256", secret)
    .update(canonicalJson({ result, logHeadHash }), "utf8")
    .digest("hex");
}

/** Checks a result signature in constant time. */
export function verifyResultSignature(
  result: unknown,
  logHeadHash: string,
  signature: string,
  secret: string = env.RESULT_SIGNING_SECRET,
): boolean {
  const expected = Buffer.from(signResult(result, logHeadHash, secret), "hex");
  const actual = Buffer.from(signature, "hex");

  if (expected.length !== actual.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
