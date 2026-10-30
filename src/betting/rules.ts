import type { Settlement } from "../odds/catalog/carrom.js";
import type { MatchRecord } from "../lib/match-repository.js";

/**
 * The betting arithmetic that must be identical everywhere: the payout, the
 * odds-drift decision and the void rules.
 *
 * All three are pure functions of their arguments, so the same rule can be
 * checked in a unit test, in an API handler and against the database.
 */

/** Odds are quantised to four decimal places before any money is computed. */
const ODDS_SCALE = 10_000;

/**
 * The payout for a stake at decimal odds: floor(stake x odds).
 *
 * The multiplication is done in integers (stake x odds scaled by 10,000) so no
 * floating point rounding can make the payout a kobo richer or poorer than the
 * database's `floor(stake * odds)`.
 */
export function payoutFor(stakeMinor: number, oddsDecimal: number): number {
  if (!Number.isInteger(stakeMinor) || stakeMinor <= 0) {
    throw new Error("the stake must be a positive integer");
  }
  if (!Number.isFinite(oddsDecimal) || oddsDecimal < 1) {
    throw new Error("odds must be at least 1");
  }

  const scaledOdds = Math.round(oddsDecimal * ODDS_SCALE);
  return Math.floor((stakeMinor * scaledOdds) / ODDS_SCALE);
}

/** The outcome of comparing the price a player saw with the price on offer. */
export type OddsCheck =
  | { readonly ok: true; readonly odds: number; readonly improved: boolean }
  | { readonly ok: false; readonly currentOdds: number };

/**
 * Odds drift: a price that fell is refused and the current price returned; a
 * price that rose is taken, at the better price. Equality is accepted.
 */
export function checkOdds(expectedOdds: number, currentOdds: number): OddsCheck {
  if (currentOdds < expectedOdds) {
    return { ok: false, currentOdds };
  }
  return { ok: true, odds: currentOdds, improved: currentOdds > expectedOdds };
}

/** Market types a forfeit still settles, because the forfeit decides them. */
export const FORFEIT_SETTLED_MARKETS = ["match_winner", "tournament_winner"] as const;

/** True when a market type is decided by a forfeit rather than voided by it. */
export function settlesOnForfeit(marketType: string): boolean {
  return (FORFEIT_SETTLED_MARKETS as readonly string[]).includes(marketType);
}

/** Why every bet on a match is void, when it is. */
export type VoidReason = "abandoned_before_first_shot" | "walkover" | null;

/**
 * The two whole-match void rules.
 *
 * - Abandoned before its first shot: nothing happened, so nothing decided.
 * - A walkover: a human seat never joined, so the match was never played.
 *
 * A forfeit is not on this list: it settles the winner market and voids the
 * rest, which is a per-market decision.
 */
export function wholeMatchVoidReason(
  match: MatchRecord,
  shots: number,
): VoidReason {
  const joined = (seat: 1 | 2): string | null | undefined =>
    seat === 1 ? match.seat1JoinedAt : match.seat2JoinedAt;

  const walkover = match.seats.some((seat) => !seat.isBot && (joined(seat.seat) ?? null) === null);

  if (walkover) {
    return "walkover";
  }
  if (shots === 0) {
    return "abandoned_before_first_shot";
  }
  return null;
}

/** How one bet settles: the outcome, the money, and whether it is held. */
export interface SettlementPlan {
  readonly outcome: Settlement;
  /** What the player is owed: the locked payout, the stake back, or nothing. */
  readonly payoutMinor: number;
  /** True when the payout is large enough to need an admin before it is released. */
  readonly hold: boolean;
}

/**
 * Turns a market's decision into money.
 *
 * - won: the locked potential payout, held when it is above the threshold.
 * - push: the stake back; nothing was won, so nothing is held.
 * - void: the stake back.
 * - lost: nothing.
 */
export function planSettlement(
  bet: { readonly stakeMinor: number; readonly potentialPayoutMinor: number },
  outcome: Settlement,
  largePayoutMinor: number,
): SettlementPlan {
  switch (outcome) {
    case "won": {
      const payoutMinor = bet.potentialPayoutMinor;
      return { outcome, payoutMinor, hold: payoutMinor > largePayoutMinor };
    }
    case "push":
    case "void":
      return { outcome, payoutMinor: bet.stakeMinor, hold: false };
    case "lost":
      return { outcome, payoutMinor: 0, hold: false };
  }
}
