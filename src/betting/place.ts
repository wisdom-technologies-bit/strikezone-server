import { z } from "zod";
import { env } from "../lib/env.js";
import { paymentAdapter } from "../wallet/payments.js";
import { BetRejected } from "./errors.js";
import type { BetsRepository } from "./bets-store.js";
import { betsRepository } from "./bets-store-store.js";
import { payoutFor } from "./rules.js";
import type { PlaceBetRequest, PlacedBet } from "./types.js";

/**
 * Placing a bet.
 *
 * The rules that decide a bet live in one place: `place_bet`, the SQL function
 * from migration 009. This module validates the request, refuses the obvious
 * mistakes before a round trip, and then hands over. It does not re-implement
 * the exposure arithmetic in JavaScript: two implementations of the bankroll
 * check is one implementation too many.
 */

/** The accepted request body for POST /api/bets. Unknown fields are refused. */
export const placeBetRequestSchema = z.strictObject({
  marketId: z.uuid(),
  stakeMinor: z.number().int().positive().max(9_000_000_000_000_000),
  expectedOdds: z.number().min(1).max(10_000),
  idempotencyKey: z.string().min(8).max(200),
});

export type PlaceBetBody = z.infer<typeof placeBetRequestSchema>;

/** The values `place_bet` needs that come from configuration, not the caller. */
export interface PlacementConfig {
  readonly minStakeMinor: number;
  readonly matchExposurePct: number;
  readonly requireKyc: boolean;
}

/** The placement configuration this process runs with. */
export function placementConfig(): PlacementConfig {
  return {
    minStakeMinor: env.MIN_STAKE_MINOR,
    matchExposurePct: env.MATCH_EXPOSURE_PCT,
    // Real money needs a verified identity; virtual play never does.
    requireKyc: paymentAdapter().mode === "real",
  };
}

export interface PlaceBetDeps {
  readonly repository?: BetsRepository;
  readonly config?: PlacementConfig;
}

/**
 * Places one bet for one player.
 *
 * @throws {BetRejected} with the code the client should show.
 */
export async function placeBet(
  userId: string,
  body: PlaceBetBody,
  deps: PlaceBetDeps = {},
): Promise<PlacedBet> {
  const config = deps.config ?? placementConfig();

  if (body.stakeMinor < config.minStakeMinor) {
    throw new BetRejected("stake_below_minimum", { minStakeMinor: config.minStakeMinor });
  }

  const request: PlaceBetRequest = {
    userId,
    marketId: body.marketId,
    stakeMinor: body.stakeMinor,
    expectedOdds: body.expectedOdds,
    idempotencyKey: body.idempotencyKey,
  };

  const repository = deps.repository ?? betsRepository();
  return repository.place(request, config);
}

/** What a caller can see when a bet is placed: the bet, plus its payout. */
export interface BetView {
  readonly id: string;
  readonly marketId: string;
  readonly stakeMinor: number;
  readonly oddsLocked: number;
  readonly potentialPayoutMinor: number;
  readonly status: string;
  readonly placedAt: string;
}

/** Projects a placed bet for the wire. */
export function toBetView(placed: PlacedBet): BetView {
  return {
    id: placed.bet.id,
    marketId: placed.bet.marketId,
    stakeMinor: placed.bet.stakeMinor,
    oddsLocked: placed.bet.oddsLocked,
    potentialPayoutMinor: placed.bet.potentialPayoutMinor,
    status: placed.bet.status,
    placedAt: placed.bet.placedAt,
  };
}

/** The payout of a stake at odds, exposed so the rules page and tests agree. */
export { payoutFor };
