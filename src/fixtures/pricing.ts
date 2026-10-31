import { logger } from "../lib/logger.js";
import type { MatchRepository } from "../lib/match-repository.js";
import { marketsRepository, type MarketsRepository } from "../odds/markets-store.js";
import { PRICE_SIMULATIONS } from "../odds/config.js";
import { priceMatch } from "../odds/pricer.js";
import { priceLudoMatch } from "../odds/ludo-pricer.js";
import type { FixtureGame } from "./types.js";

/**
 * Pricing one fixture before it starts.
 *
 * The prices are the pricer's, unchanged; what this adds is a time budget. A
 * price is a fixed number of simulated matches, and on a small host the full
 * count can take longer than the fixture has before it must open. So:
 *
 * 1. A short probe measures this machine's rate for the game.
 * 2. If the full count fits the budget, price at the full count.
 * 3. If it does not, price at the reduced count and say so, loudly, with the
 *    numbers: a reduced price is a still-useful price, but an operator should be
 *    able to see that the host is too slow for the one it wanted.
 *
 * Ludo already does this inside its own pricer (it calibrates, then falls back to
 * 200,000 games), so here it is only a pass-through with the same report shape.
 */

/** Simulations behind a fixture price when the host can afford them. */
export const FIXTURE_PRICE_SIMULATIONS = PRICE_SIMULATIONS;
/** What a fixture is priced at when the full count will not fit the budget. */
export const FIXTURE_REDUCED_SIMULATIONS = 20_000;
/** The probe: a few thousand Carrom matches, enough to measure a rate. */
export const FIXTURE_PROBE_SIMULATIONS = 2_000;
/** How long a Carrom fixture's price may take before it is reduced. */
export const FIXTURE_PRICE_BUDGET_MS = 20_000;
/**
 * The same for Ludo, which is dearer per game and whose pricer will not go below
 * 200,000 games: on the host this was measured on, that floor is about 40 seconds,
 * so a 20 second budget would only produce a warning nobody can act on.
 */
export const FIXTURE_LUDO_PRICE_BUDGET_MS = 60_000;

export interface FixturePriceReport {
  readonly matchId: string;
  readonly game: FixtureGame;
  /** Simulated matches behind the price that was written. */
  readonly simulations: number;
  /** True when the reduced count was used to stay inside the budget. */
  readonly reduced: boolean;
  readonly elapsedMs: number;
}

export interface FixturePricingDeps {
  readonly matches?: MatchRepository;
  readonly markets?: MarketsRepository;
  readonly now?: () => number;
  readonly simulations?: number;
  readonly reducedSimulations?: number;
  readonly probeSimulations?: number;
  readonly budgetMs?: number;
}

/** Prices a fixture, and never lets the clock decide for it silently. */
export async function priceFixture(
  matchId: string,
  game: FixtureGame,
  deps: FixturePricingDeps = {},
): Promise<FixturePriceReport> {
  const now = deps.now ?? (() => Date.now());
  const matches = deps.matches;
  const markets = deps.markets ?? marketsRepository();
  const budgetMs = deps.budgetMs ?? FIXTURE_PRICE_BUDGET_MS;

  if (game === "ludo") {
    const report = await priceLudoMatch(matchId, {
      repository: markets,
      ...(matches === undefined ? {} : { matches }),
      budgetMs: deps.budgetMs ?? FIXTURE_LUDO_PRICE_BUDGET_MS,
    });
    return {
      matchId,
      game,
      simulations: report.gamesPlayed,
      reduced: report.fellBack,
      elapsedMs: report.elapsedMs,
    };
  }

  const full = deps.simulations ?? FIXTURE_PRICE_SIMULATIONS;
  const reduced = Math.min(full, deps.reducedSimulations ?? FIXTURE_REDUCED_SIMULATIONS);
  const probe = Math.min(reduced, deps.probeSimulations ?? FIXTURE_PROBE_SIMULATIONS);

  // The probe writes nothing: it exists to time this host, not to price the match.
  const probeStarted = now();
  await priceMatch(matchId, {
    simulations: probe,
    repository: markets,
    ...(matches === undefined ? {} : { matches }),
    write: false,
  });
  const probeMs = Math.max(1, now() - probeStarted);
  const perSimulationMs = probeMs / Math.max(1, probe);
  const projectedFullMs = full * perSimulationMs;

  if (projectedFullMs > budgetMs) {
    const started = now();
    await priceMatch(matchId, {
      simulations: reduced,
      repository: markets,
      ...(matches === undefined ? {} : { matches }),
    });
    const elapsedMs = now() - started;
    logger.warn(
      {
        matchId,
        simulations: reduced,
        fullSimulations: full,
        probeMs,
        projectedFullMs: Math.round(projectedFullMs),
        budgetMs,
        elapsedMs,
      },
      "fixture priced on the reduced simulation count to fit the time budget",
    );
    return { matchId, game, simulations: reduced, reduced: true, elapsedMs };
  }

  const started = now();
  await priceMatch(matchId, {
    simulations: full,
    repository: markets,
    ...(matches === undefined ? {} : { matches }),
  });

  return { matchId, game, simulations: full, reduced: false, elapsedMs: now() - started };
}
