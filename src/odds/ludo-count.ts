/**
 * Turning a simulated game into a tally of winning selections.
 *
 * The pricer's whole arithmetic is here: one `settle` per selection per game, and
 * a counter per selection. It is separated from both the simulator and the pricer
 * because the worker threads and the single-threaded path have to count exactly
 * the same way, and because a test can count a handful of known games without
 * touching a worker.
 *
 * A selection's identity is its market, subject, line and key, joined into one
 * string. That string is the only thing that crosses a thread boundary: the
 * workers rebuild the catalogue themselves and write their tallies under the same
 * keys, so a merge is a sum and cannot silently reorder anything.
 */

import type { CatalogMarket } from "./catalog/carrom.js";
import type { LudoCatalog } from "./catalog/ludo.js";
import type { LudoGameStats } from "./ludo-stats.js";

/** One selection, as a worker is told about it. */
export interface SelectionRef {
  readonly key: string;
  readonly marketType: string;
  readonly subject: string;
  readonly line: number | null;
}

/** The separator between the parts of a selection key. Not allowed in any part. */
const SEPARATOR = "\u0001";

/** The composite key a tally is kept under. */
export function selectionId(ref: SelectionRef): string {
  return [ref.marketType, ref.subject, String(ref.line ?? ""), ref.key].join(SEPARATOR);
}

/** Every selection of every market in a catalogue instance. */
export function describeSelections(
  markets: readonly CatalogMarket[],
  filter?: (market: CatalogMarket) => boolean,
): SelectionRef[] {
  const refs: SelectionRef[] = [];
  for (const market of markets) {
    if (filter !== undefined && !filter(market)) {
      continue;
    }
    for (const selection of market.selections) {
      refs.push({
        key: selection.key,
        marketType: market.marketType,
        subject: market.subject,
        line: market.line,
      });
    }
  }
  return refs;
}

/** How a selection fared: how often it won, and how often it was decided at all. */
export interface SelectionTally {
  readonly won: number;
  readonly decided: number;
}

/**
 * A tally per selection, keyed by {@link selectionId}.
 *
 * `decided` is kept apart from `won` because a void selection is not a loss: a
 * market the match never reached must be priced on the games that judged it, or
 * an abandoned simulation would drag a price toward zero.
 */
export type LudoCounts = Map<string, SelectionTally>;

/** Counts one game into the tallies. */
export function countGame(
  catalog: LudoCatalog,
  refs: readonly SelectionRef[],
  stats: LudoGameStats,
  counts: LudoCounts,
): void {
  for (const ref of refs) {
    const id = selectionId(ref);
    const settlement = catalog.settle(
      { marketType: ref.marketType, subject: ref.subject, line: ref.line },
      ref.key,
      stats,
    );
    const current = counts.get(id) ?? { won: 0, decided: 0 };
    if (settlement === "void") {
      // A hole would read as "never judged"; a zero-decided entry says so.
      counts.set(id, current);
      continue;
    }
    counts.set(id, {
      won: current.won + (settlement === "won" ? 1 : 0),
      decided: current.decided + 1,
    });
  }
}

/** A tally as the plain pairs a worker can post back. */
export function countsToObject(counts: LudoCounts): Record<string, readonly [number, number]> {
  const out: Record<string, readonly [number, number]> = {};
  for (const [id, value] of counts) {
    out[id] = [value.won, value.decided];
  }
  return out;
}

/** Merges a worker's tallies into the total. */
export function mergeCounts(
  total: LudoCounts,
  part: Readonly<Record<string, readonly [number, number]>>,
): void {
  for (const [id, value] of Object.entries(part)) {
    const current = total.get(id) ?? { won: 0, decided: 0 };
    total.set(id, { won: current.won + value[0], decided: current.decided + value[1] });
  }
}
