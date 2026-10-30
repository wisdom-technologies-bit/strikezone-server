/**
 * Why a bet was refused, as a code the client can branch on.
 *
 * The codes match the ones `place_bet` returns, so a rejection from the database
 * and a rejection detected on the way to it look the same to the caller.
 */
export const BET_REJECTION_CODES = [
  "invalid_request",
  "invalid_stake",
  "invalid_odds",
  "invalid_idempotency_key",
  "idempotency_conflict",
  "user_not_found",
  "market_not_found",
  "market_closed",
  "odds_moved",
  "stake_below_minimum",
  "stake_above_market_max",
  "stake_above_limit",
  "daily_loss_limit",
  "rate_limited",
  "self_excluded",
  "kyc_required",
  "insufficient_funds",
  "betting_paused",
  "match_exposure_cap",
  "global_exposure_cap",
  "house_account_missing",
  "escrow_account_missing",
] as const;

export type BetRejectionCode = (typeof BET_REJECTION_CODES)[number];

/** Everything the database said about a refusal, for the client and the log. */
export interface BetRejectionDetails {
  readonly [key: string]: string | number | boolean | null;
}

/** Raised when the money layer refuses a bet. */
export class BetRejected extends Error {
  readonly code: BetRejectionCode;
  readonly details: BetRejectionDetails;

  constructor(code: BetRejectionCode, details: BetRejectionDetails = {}) {
    super(`bet refused: ${code}`);
    this.name = "BetRejected";
    this.code = code;
    this.details = details;
  }

  /** The HTTP status this refusal deserves. */
  get status(): number {
    switch (this.code) {
      case "market_not_found":
      case "user_not_found":
        return 404;
      case "rate_limited":
        return 429;
      case "invalid_request":
      case "invalid_stake":
      case "invalid_odds":
      case "invalid_idempotency_key":
        return 400;
      default:
        return 409;
    }
  }
}

/** True when a string is one of the rejection codes. */
export function isRejectionCode(value: string): value is BetRejectionCode {
  return (BET_REJECTION_CODES as readonly string[]).includes(value);
}
