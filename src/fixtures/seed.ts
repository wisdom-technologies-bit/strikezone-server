import { createHmac } from "node:crypto";
import { commitOf } from "../lib/fair-rng.js";

/**
 * The seed of a house fixture.
 *
 * It has to be knowable by the server at any time (a fixture is priced in one
 * tick and launched in another, and a restart in between must not lose it) and
 * unknowable by anyone else until the match ends. Both hold if the seed is
 * derived from the result-signing secret and the match id: the id is public, the
 * secret is not, and the same match id always gives the same seed.
 *
 * That is the same trust model as a random seed made by the server: the operator
 * could have chosen it, and the commitment published before play is what proves
 * the choice was not made after the result was known.
 */
export function fixtureSeed(matchId: string, secret: string): string {
  return createHmac("sha256", secret).update(`house-fixture:${matchId}`, "utf8").digest("hex");
}

/** The commitment published on the match row before anyone plays. */
export function fixtureSeedCommit(matchId: string, secret: string): string {
  return commitOf(fixtureSeed(matchId, secret));
}
