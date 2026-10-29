import { SupabaseMatchRepository, type MatchRepository } from "./match-repository.js";

/**
 * The one match store the process uses.
 *
 * Resolved lazily so importing this module never builds a Supabase client: the
 * tests swap in the in-memory store and never touch the network, and a process
 * that only serves /health never needs one either.
 */

let override: MatchRepository | null = null;
let supabaseStore: MatchRepository | null = null;

/** The repository every room, endpoint and script should use. */
export function matchRepository(): MatchRepository {
  if (override !== null) {
    return override;
  }
  supabaseStore ??= new SupabaseMatchRepository();
  return supabaseStore;
}

/** Replaces the store, for tests. Pass null to go back to Supabase. */
export function setMatchRepository(repository: MatchRepository | null): void {
  override = repository;
}
