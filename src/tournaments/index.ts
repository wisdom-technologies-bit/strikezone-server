import { matchRepository } from "../lib/match-store.js";
import { ledger } from "../wallet/ledger.js";
import { colyseusLauncher, type MatchLauncher } from "./launcher.js";
import { tournamentRepository, type TournamentRepository } from "./repository.js";
import { TournamentService } from "./service.js";

/**
 * Wiring, in one place.
 *
 * The service takes its collaborators as arguments so a test can pass its own;
 * production code asks for the composed instance here rather than building one.
 */

let service: TournamentService | null = null;

/** The service the API and the scheduler use. */
export function tournamentService(): TournamentService {
  service ??= createTournamentService();
  return service;
}

/** Builds a service from the process's stores. */
export function createTournamentService(options?: {
  readonly repository?: TournamentRepository;
  readonly launcher?: MatchLauncher;
}): TournamentService {
  return new TournamentService({
    repository: options?.repository ?? tournamentRepository(),
    matches: matchRepository(),
    ledger: ledger(),
    launcher: options?.launcher ?? colyseusLauncher,
  });
}

/**
 * Drops the composed service, so the next call rebuilds it.
 *
 * The stores are swappable (see match-store, ledger, repository), and a test that
 * swaps one needs the service rebuilt around it.
 */
export function resetTournamentService(): void {
  service = null;
}

export { TournamentService, TournamentError } from "./service.js";
export type { TournamentErrorCode, CreateTournamentRequest } from "./service.js";
export type { MatchLauncher } from "./launcher.js";
export type { TournamentRepository } from "./repository.js";
export { tournamentRepository, setTournamentRepository } from "./repository.js";
