/**
 * The three Ludo bot policies, in one place.
 *
 * GET /api/bots publishes this list, and the room was built with the same list as
 * the Carrom room: a bot is always labelled, `is_bot` is always true, and a bot
 * never reads a bet, a stake or a liability (AI_RULES.md, hard rule 4). A policy
 * sees the board and the roll and nothing else.
 */

/** The ids a client may ask for. */
export type LudoBotId = "cautious" | "aggressive" | "racer";

/** One published policy. */
export interface LudoBotPolicy {
  readonly id: LudoBotId;
  /** The name shown to players, which always starts with "Bot ". */
  readonly name: string;
  readonly isBot: true;
  /** One line for the site's bot picker. */
  readonly description: string;
}

/** Every policy, in the order the site shows them. */
export const LUDO_BOT_POLICIES: readonly LudoBotPolicy[] = Object.freeze([
  Object.freeze({
    id: "cautious" as const,
    name: "Bot Cautious",
    isBot: true as const,
    description:
      "Keeps tokens out of reach: leaves a square when an opponent could land on it, and prefers safe squares and the home column.",
  }),
  Object.freeze({
    id: "aggressive" as const,
    name: "Bot Aggressive",
    isBot: true as const,
    description: "Hunts: takes any capture on offer, and only advances when there is nothing to take.",
  }),
  Object.freeze({
    id: "racer" as const,
    name: "Bot Racer",
    isBot: true as const,
    description: "Ignores the opponents and pushes the token nearest home, every roll.",
  }),
]);

/** The ids, for validation. */
export const LUDO_BOT_IDS: readonly LudoBotId[] = LUDO_BOT_POLICIES.map((policy) => policy.id);

/** One policy by id, or null when there is no such policy. */
export function ludoBot(id: string): LudoBotPolicy | null {
  return LUDO_BOT_POLICIES.find((policy) => policy.id === id) ?? null;
}
