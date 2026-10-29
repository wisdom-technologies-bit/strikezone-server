import type { BotPrizePolicy } from "./types.js";

/**
 * Where a tournament's money goes: the rake, then the prizes, then whatever the
 * house keeps.
 *
 * Every amount is an integer in the smallest unit and every step is integer
 * arithmetic, so the parts always add back up to the pool exactly. The function
 * proves that before returning: if the legs do not sum to the pool it throws
 * rather than pay a wrong number.
 */

/** One finisher, in finishing order. */
export interface PrizeFinisher {
  readonly playerId: string;
  readonly place: number;
}

/** What the calculator needs to know about one player. */
export interface PrizePlayer {
  readonly isBot: boolean;
  readonly displayName?: string;
}

/** Everything needed to split a pool. */
export interface PrizeInput {
  /** The pool as it stands, in the smallest unit: every entry fee paid in. */
  readonly poolMinor: number;
  /** House rake in basis points of the pool. */
  readonly rakeBps: number;
  /** Shares by place, best first, as whole percentages. */
  readonly prizeSplit: readonly number[];
  /** Every finisher, best place first. */
  readonly order: readonly PrizeFinisher[];
  readonly players: ReadonlyMap<string, PrizePlayer>;
  readonly botPrizePolicy: BotPrizePolicy;
}

/** One payment. `viaBotPlayerId` is set when the money was won by a bot. */
export interface PrizePayout {
  readonly playerId: string;
  readonly place: number;
  readonly amountMinor: number;
  readonly viaBotPlayerId: string | null;
}

/** The split, ready to post to the ledger. */
export interface PrizeResult {
  readonly poolMinor: number;
  readonly rakeMinor: number;
  /** Pool minus rake: the most that can reach players. */
  readonly distributableMinor: number;
  readonly payouts: readonly PrizePayout[];
  /** Rake plus anything a bot's prize left with the house. */
  readonly houseMinor: number;
}

/** The pool after the rake. Throws on a negative pool or an oversized rake. */
export function rakeOf(poolMinor: number, rakeBps: number): number {
  if (!Number.isInteger(poolMinor) || poolMinor < 0) {
    throw new Error(`the prize pool must be a non-negative integer, got ${String(poolMinor)}`);
  }
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 10_000) {
    throw new Error(`the rake must be basis points between 0 and 10000, got ${String(rakeBps)}`);
  }
  return Math.floor((poolMinor * rakeBps) / 10_000);
}

/**
 * Splits the post-rake pool across the finishing order.
 *
 * The percentage split is renormalised to the number of players actually being
 * paid, so a 60/30/10 default pays 1200/600 of an 1800 pool in a two-entrant
 * final instead of stranding the 10% the third place would have taken. The integer remainders go to first place, which is the
 * convention everywhere else in this codebase.
 */
export function computePrizes(input: PrizeInput): PrizeResult {
  const { poolMinor, rakeBps, prizeSplit, order, players, botPrizePolicy } = input;

  if (order.length === 0) {
    // Nothing to pay: the pool itself (rake included) stays with the house.
    const rakeOnly = rakeOf(poolMinor, rakeBps);
    return {
      poolMinor,
      rakeMinor: rakeOnly,
      distributableMinor: poolMinor - rakeOnly,
      payouts: [],
      houseMinor: poolMinor,
    };
  }

  const rakeMinor = rakeOf(poolMinor, rakeBps);
  const distributableMinor = poolMinor - rakeMinor;

  const paidPlaces = Math.min(prizeSplit.length, order.length);
  const shares = prizeSplit.slice(0, paidPlaces);
  const shareTotal = shares.reduce((sum, share) => sum + share, 0);

  const payouts: PrizePayout[] = [];
  let houseMinor = rakeMinor;

  if (shareTotal <= 0) {
    // A split of all zeros means nobody is paid: the pool goes to the house.
    return {
      poolMinor,
      rakeMinor,
      distributableMinor,
      payouts: [],
      houseMinor: poolMinor,
    };
  }

  const amounts: number[] = shares.map((share) =>
    Math.floor((distributableMinor * share) / shareTotal),
  );

  // Hand the rounding remainder to first place so the total is exact.
  const assigned = amounts.reduce((sum, amount) => sum + amount, 0);
  const remainder = distributableMinor - assigned;
  if (amounts.length > 0) {
    amounts[0] = (amounts[0] ?? 0) + remainder;
  }

  for (let index = 0; index < amounts.length; index += 1) {
    const amountMinor = amounts[index] ?? 0;
    const finisher = order[index];
    if (finisher === undefined || amountMinor <= 0) {
      continue;
    }

    const player = players.get(finisher.playerId);
    const isBot = player?.isBot ?? false;

    if (!isBot) {
      payouts.push({
        playerId: finisher.playerId,
        place: finisher.place,
        amountMinor,
        viaBotPlayerId: null,
      });
      continue;
    }

    // A bot won this place. Either the house keeps it, or it passes down to the
    // best-placed human below: the first human in the remaining order.
    if (botPrizePolicy === "house_keeps") {
      houseMinor += amountMinor;
      continue;
    }

    const nextHuman = order
      .slice(index + 1)
      .find((candidate) => (players.get(candidate.playerId)?.isBot ?? false) === false);

    if (nextHuman === undefined) {
      houseMinor += amountMinor;
      continue;
    }

    payouts.push({
      playerId: nextHuman.playerId,
      place: finisher.place,
      amountMinor,
      viaBotPlayerId: finisher.playerId,
    });
  }

  const paidOut = payouts.reduce((sum, payout) => sum + payout.amountMinor, 0);
  const total = paidOut + houseMinor;
  if (total !== poolMinor) {
    throw new Error(
      `the prize split does not balance: paid ${String(paidOut)} plus house ${String(houseMinor)} is not the pool ${String(poolMinor)}`,
    );
  }

  return { poolMinor, rakeMinor, distributableMinor, payouts, houseMinor };
}
