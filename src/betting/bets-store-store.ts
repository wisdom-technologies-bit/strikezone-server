import {
  InMemoryBetsRepository,
  SupabaseBetsRepository,
  type BetsRepository,
} from "./bets-store.js";

/**
 * The bets repository the process uses.
 *
 * Same pattern as the ledger: one switch, so tests can install an in-memory book
 * and every production path still reads the database.
 */

let override: BetsRepository | null = null;
let supabaseBets: BetsRepository | null = null;

export function betsRepository(): BetsRepository {
  if (override !== null) {
    return override;
  }
  supabaseBets ??= new SupabaseBetsRepository();
  return supabaseBets;
}

export function setBetsRepository(replacement: BetsRepository | null): void {
  override = replacement;
}

export type { BetsRepository };
export { InMemoryBetsRepository, SupabaseBetsRepository };
