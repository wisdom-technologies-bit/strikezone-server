/**
 * The shapes the betting layer passes around.
 *
 * A bet is one stake on one selection at a locked price. Every amount is an
 * integer in the smallest unit; `oddsLocked` is the only decimal number in the
 * model, and it is never used for arithmetic after the payout is computed.
 */

export const BET_STATUSES = [
  "open",
  "pending_review",
  "won",
  "lost",
  "void",
  "cashed_out",
] as const;

export type BetStatus = (typeof BET_STATUSES)[number];

/** What the market decided, independent of whether the money has moved. */
export const BET_RESULTS = ["won", "lost", "void", "push"] as const;

export type BetResult = (typeof BET_RESULTS)[number];

/** One bet row, as the money layer needs to see it. */
export interface BetRow {
  readonly id: string;
  readonly userId: string;
  readonly marketId: string;
  readonly stakeMinor: number;
  readonly oddsLocked: number;
  readonly potentialPayoutMinor: number;
  readonly status: BetStatus;
  readonly result: BetResult | null;
  readonly payoutMinor: number | null;
  readonly idempotencyKey: string;
  readonly placedAt: string;
  readonly settledAt: string | null;
  readonly reviewReason: string | null;
}

/** The market facts a settlement decision needs, joined onto the bet. */
export interface MarketFacts {
  /** The market row's own id. Named apart from the bet id on purpose. */
  readonly marketRowId: string;
  readonly matchId: string;
  readonly marketType: string;
  readonly subject: string;
  readonly line: number | null;
  readonly selectionKey: string;
}

/** A bet with its market attached: what settlement reads. */
export interface BetWithMarket extends BetRow, MarketFacts {}

/** What a caller asks for when placing a bet. */
export interface PlaceBetRequest {
  readonly userId: string;
  readonly marketId: string;
  readonly stakeMinor: number;
  readonly expectedOdds: number;
  readonly idempotencyKey: string;
}

/** A placed bet, with the balance the player has left. */
export interface PlacedBet {
  readonly bet: BetRow;
  readonly replayed: boolean;
  readonly balanceMinor: number;
}
