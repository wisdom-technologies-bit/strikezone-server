import { resolveLudoConfig, type LudoConfig } from "../engines/ludo/index.js";
import type { MatchRecord } from "./match-repository.js";

/**
 * The Ludo rules a match was played under, read back from its stored config.
 *
 * Anything missing falls back to the engine default, so a match recorded before a
 * tunable existed still verifies. The room uses this to start a match and the
 * verifier uses it to replay one, which is why it lives here rather than beside
 * either of them.
 */
export function ludoConfigFromMatch(match: MatchRecord): Partial<LudoConfig> {
  const stored = match.config["ludo"];
  if (typeof stored !== "object" || stored === null) {
    return {};
  }

  const record = stored as Record<string, unknown>;
  const keys: readonly (keyof LudoConfig)[] = [
    "players",
    "tokensPerPlayer",
    "extraRollOnSix",
    "tripleSixForfeit",
    "extraRollOnCapture",
    "extraRollOnHome",
    "stacking",
    "moveSeconds",
    "timeoutsToForfeit",
  ];

  const clean: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      clean[key] = value;
    }
  }
  return clean as Partial<LudoConfig>;
}

/** The full rules for a match: its stored overrides over the engine defaults. */
export function ludoRulesForMatch(match: MatchRecord): LudoConfig {
  return resolveLudoConfig({ players: 4, ...ludoConfigFromMatch(match) });
}
