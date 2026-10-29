/**
 * Seeding: who plays whom first, and who gets a bye.
 *
 * The bracket order is the standard one: seeds are laid out so that the top seed
 * meets the weakest, the second seed sits at the other end of the bracket, and
 * any pair of seeds that meet early is the pair that should. Getting this right
 * is what makes a bye worth anything: with five players in an eight slot bracket
 * the three byes must fall to seeds 1, 2 and 3, not to whoever happens to sit in
 * the first three slots.
 */

/** The next power of two at or above the entrant count, never below 2. */
export function bracketSize(entrants: number): number {
  if (!Number.isInteger(entrants) || entrants < 2) {
    throw new Error(`a bracket needs at least 2 entrants, got ${String(entrants)}`);
  }
  let size = 2;
  while (size < entrants) {
    size *= 2;
  }
  return size;
}

/** How many byes a bracket of this size hands out for this many entrants. */
export function byeCount(entrants: number): number {
  return bracketSize(entrants) - entrants;
}

/**
 * The seed standing in each bracket slot, 1-based, for a full bracket.
 *
 * Built by doubling: each expansion mirrors the existing order and replaces each
 * seed `s` with the pair `[s, n + 1 - s]`, which is the standard construction.
 * For an eight slot bracket the result is 1, 8, 4, 5, 2, 7, 3, 6: seed 1 meets 8,
 * seed 4 meets 5, and 1 and 2 can only meet in the final.
 */
export function seedOrder(size: number): readonly number[] {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
    throw new Error(`the bracket size must be a power of two, got ${String(size)}`);
  }

  let order: number[] = [1];
  while (order.length < size) {
    const doubled = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed);
      next.push(doubled + 1 - seed);
    }
    order = next;
  }

  return order;
}

/** One first-round pairing, seats as seeds with null for an empty (bye) seat. */
export interface FirstRoundPair {
  readonly slot: number;
  readonly seat1Seed: number | null;
  readonly seat2Seed: number | null;
}

/** The first round of a bracket for this many entrants, byes included. */
export function firstRound(entrants: number): {
  readonly size: number;
  readonly byes: number;
  readonly pairs: readonly FirstRoundPair[];
  readonly seeds: readonly (number | null)[];
} {
  const size = bracketSize(entrants);
  const order = seedOrder(size);
  const seeds = order.map((seed) => (seed <= entrants ? seed : null));

  const pairs: FirstRoundPair[] = [];
  for (let index = 0; index < size; index += 2) {
    pairs.push({
      slot: index / 2 + 1,
      seat1Seed: seeds[index] ?? null,
      seat2Seed: seeds[index + 1] ?? null,
    });
  }

  return { size, byes: size - entrants, pairs, seeds };
}

/**
 * Turns entrants into seeds, strongest first.
 *
 * Rating decides; the tie-breaks are chosen so that the same entrant list always
 * produces the same bracket, whatever order the rows came back in.
 */
export function seedByRating<
  T extends {
    readonly playerId: string;
    readonly rating: number;
    readonly displayName: string;
    readonly registeredAt: string | null;
  },
>(entrants: readonly T[]): readonly (T & { readonly seed: number })[] {
  const ordered = [...entrants].sort((left, right) => {
    if (right.rating !== left.rating) {
      return right.rating - left.rating;
    }
    if (left.displayName !== right.displayName) {
      return left.displayName < right.displayName ? -1 : 1;
    }
    const leftAt = left.registeredAt ?? "";
    const rightAt = right.registeredAt ?? "";
    if (leftAt !== rightAt) {
      return leftAt < rightAt ? -1 : 1;
    }
    return left.playerId < right.playerId ? -1 : 1;
  });

  return ordered.map((entry, index) => ({ ...entry, seed: index + 1 }));
}
