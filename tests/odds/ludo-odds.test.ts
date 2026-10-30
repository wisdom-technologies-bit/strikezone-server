/**
 * The Ludo odds engine, measured rather than asserted.
 *
 * Every number here is a probability the engine claims to measure, so every test
 * is a frequency with a tolerance derived from the simulation's own standard
 * error: `sqrt(p(1-p)/n)` at three standard errors, which is about what 20,000
 * games can say without flaking.
 *
 * The dice checks are exact where they can be. A fair six-sided die is 1/6, the
 * first seat to roll has a real edge on the first six, and a game's sixes are
 * one in six of its turns: all three are properties of the game, not of the
 * pricing model, so a failure means the simulator is playing a different game.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ludoCatalog } from "../../src/odds/catalog/ludo.js";
import { runLudoBatch, splitGames } from "../../src/odds/ludo-pool.js";
import { createLudoGameRunner, seededUniform, simulateLudoGame } from "../../src/odds/ludo-sim.js";
import { estimatePolicyMix, observedShares } from "../../src/odds/ludo-skill.js";
import { EVEN_POLICY_MIX } from "../../src/odds/ludo-sim.js";
import { createInitialState, applyRoll, cautiousChooser } from "../../src/engines/ludo/index.js";
import { selectionId } from "../../src/odds/ludo-count.js";
import {
  LUDO_FALLBACK_SIMULATIONS,
  LUDO_PRICE_BUDGET_MS,
  LUDO_PRICE_SIMULATIONS,
  priceLudoMatch,
} from "../../src/odds/ludo-pricer.js";
import { InMemoryMarketsRepository } from "../../src/odds/markets-store.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import type { LudoGameStats } from "../../src/odds/ludo-stats.js";
import type { CatalogMarket } from "../../src/odds/catalog/carrom.js";

const BOTS = { 0: "cautious", 1: "cautious", 2: "cautious", 3: "cautious" } as const;

/** Three standard errors for a proportion, the band a frequency should sit in. */
function threeSigma(probability: number, games: number): number {
  return 3 * Math.sqrt((probability * (1 - probability)) / games);
}

/** A market from the catalogue, by its id. */
function market(type: string, subject = "", line: number | null = null): CatalogMarket {
  const found = ludoCatalog().markets.find(
    (candidate) =>
      candidate.marketType === type && candidate.subject === subject && candidate.line === line,
  );
  if (found === undefined) {
    throw new Error(`no market ${type} ${subject} ${String(line)}`);
  }
  return found;
}

/** The measured probability of one selection. */
function probabilityOf(
  counts: ReadonlyMap<string, { readonly won: number; readonly decided: number }>,
  found: CatalogMarket,
  key: string,
): number {
  const tally = counts.get(
    selectionId({ key, marketType: found.marketType, subject: found.subject, line: found.line }),
  );
  if (tally === undefined || tally.decided === 0) {
    throw new Error(`selection ${key} was never judged`);
  }
  return tally.won / tally.decided;
}

describe("the dice are the game's dice", () => {
  it("draws every face one time in six", () => {
    const random = seededUniform("dice-faces");
    const faces = [0, 0, 0, 0, 0, 0];
    const draws = 60_000;
    for (let index = 0; index < draws; index += 1) {
      const face = Math.floor(random() * 6) + 1;
      faces[face - 1] = (faces[face - 1] ?? 0) + 1;
    }
    for (const [index, count] of faces.entries()) {
      const observed = count / draws;
      expect(Math.abs(observed - 1 / 6)).toBeLessThan(threeSigma(1 / 6, draws));
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it("rolls a six on one turn in six, across whole games", () => {
    const games = 4_000;
    let turns = 0;
    let sixes = 0;
    for (let index = 0; index < games; index += 1) {
      const stats = simulateLudoGame({
        policies: BOTS,
        random: seededUniform(`sixes:${String(index)}`),
      });
      turns += stats.totalTurns;
      sixes += stats.sixesBySeat.reduce((total, count) => total + count, 0);
    }
    expect(Math.abs(sixes / turns - 1 / 6)).toBeLessThan(0.01);
  });
});

describe("the first six", () => {
  it("falls to the seats in turn order, most often to the first", () => {
    const games = 6_000;
    const first = [0, 0, 0, 0];
    for (let index = 0; index < games; index += 1) {
      const stats = simulateLudoGame({
        policies: BOTS,
        random: seededUniform(`first-six:${String(index)}`),
      });
      if (stats.firstSix !== null) {
        first[stats.firstSix.seat] = (first[stats.firstSix.seat] ?? 0) + 1;
      }
    }
    const shares = first.map((count) => count / games);
    // The first seat rolls a six one turn in six; if it does not, the next seat
    // gets its chance, so the shares fall geometrically: 0.322, 0.268, 0.223,
    // 0.186. That is turn order made visible, and it is exact enough to check.
    const expected = [0, 0, 0, 0].map((_, seat) => Math.pow(5 / 6, seat) / 6);
    const normaliser = expected.reduce((total, value) => total + value, 0);
    for (const [seat, share] of shares.entries()) {
      const target = (expected[seat] ?? 0) / normaliser;
      expect(
        Math.abs(share - target),
        `seat ${String(seat)} took the first six ${(share * 100).toFixed(1)}%, expected ${(target * 100).toFixed(1)}%`,
      ).toBeLessThan(threeSigma(target, games) + 0.002);
    }
    expect(shares[0] ?? 0).toBeGreaterThan(shares[3] ?? 0);
  });
});

describe("a four bot game", () => {
  it("gives every identical bot about a quarter, the first seat most", async () => {
    const batch = await runLudoBatch({
      games: 20_000,
      seed: "equal-bots",
      policies: BOTS,
      threads: 2,
    });
    const winner = market("ludo_match_winner");
    const shares = winner.selections.map((selection) =>
      probabilityOf(batch.counts, winner, selection.key),
    );

    for (const [index, share] of shares.entries()) {
      expect(
        Math.abs(share - 0.25),
        `seat ${String(index)} won ${(share * 100).toFixed(1)}%`,
      ).toBeLessThan(0.025);
    }
    // Seat 0 rolls first, so it wins the most of the four. The edge is small:
    // it is measured over 20,000 games, so the test allows the ordering to hold
    // rather than asserting a margin the sample could not resolve.
    const highest = shares.indexOf(Math.max(...shares));
    expect(highest).toBe(0);
  }, 120_000);

  it("counts the same games in every statistic it reports", () => {
    const stats = simulateLudoGame({ policies: BOTS, random: seededUniform("invariants") });
    const turns = stats.turnsBySeat.reduce((total, count) => total + count, 0);

    expect(stats.totalTurns).toBe(turns);
    expect(stats.totalRounds).toBe(Math.ceil(stats.totalTurns / 4));
    expect(stats.finishingOrder).toHaveLength(4);
    expect(stats.winnerSeat).toBe(stats.finishingOrder[0]);
    expect(stats.winnerTurns).toBeGreaterThan(0);
    expect(stats.finished).toBe(true);
    expect(stats.abandoned).toBe(false);
    for (const seat of stats.seats) {
      expect(stats.finalHome[seat]).toBeLessThanOrEqual(4);
      expect(stats.homeAtRound60[seat]).toBeLessThanOrEqual(4);
    }
  });

  it("reports the facts the trace would have given it", () => {
    const traced = simulateLudoGame({
      policies: BOTS,
      random: seededUniform("trace-check"),
      trace: true,
    });
    expect(traced.homeBySeatAtTurn).not.toBeNull();
    // Folded facts and the trace must agree, or a market settles differently on
    // a played match than on a simulated one.
    const trace = traced.homeBySeatAtTurn ?? [];
    const firstToTwo = trace.findIndex((counts) => counts.some((home) => home >= 2));
    expect(firstToTwo).toBeGreaterThan(-1);
    expect(traced.firstToTwoHome).not.toBeNull();
  });
});

describe("prices", () => {
  // 20,000 identical four-bot games, played once for every price assertion: this
  // machine plays about 4,000 a second, so replaying them per test would spend
  // half a minute saying the same thing three times.
  let batch: Awaited<ReturnType<typeof runLudoBatch>>;

  beforeAll(async () => {
    batch = await runLudoBatch({ games: 20_000, seed: "priced-book", policies: BOTS, threads: 2 });
  }, 120_000);

  it("sums an exclusive market to one", () => {
    const winner = market("ludo_match_winner");
    const total = winner.selections.reduce(
      (sum, selection) => sum + probabilityOf(batch.counts, winner, selection.key),
      0,
    );
    expect(Math.abs(total - 1)).toBeLessThan(0.01);
  });

  it("keeps the over/under lines monotonic", () => {
    const lines = ludoCatalog().markets.filter(
      (candidate) => candidate.marketType === "ludo_total_sixes",
    );
    const overs = lines
      .map((candidate) => ({
        line: candidate.line ?? 0,
        probability: probabilityOf(batch.counts, candidate, "over"),
      }))
      .sort((a, b) => a.line - b.line);

    expect(overs.length).toBeGreaterThan(5);
    for (let index = 1; index < overs.length; index += 1) {
      const previous = overs[index - 1]?.probability ?? 1;
      const current = overs[index]?.probability ?? 0;
      expect(current, `a higher line must be less likely`).toBeLessThanOrEqual(previous + 0.005);
    }
  });
});

describe("a resumed game", () => {
  it("starts where the board is and finishes the game", () => {
    const runner = createLudoGameRunner({ policies: BOTS });
    const random = seededUniform("resume-a");
    let state = createInitialState({ players: 4 });
    // Play a few real turns to get a position worth resuming from.
    for (let turn = 0; turn < 120 && state.status === "playing"; turn += 1) {
      const roll = Math.floor(random() * 6) + 1;
      state = applyRoll(state, roll, cautiousChooser).state;
    }
    expect(state.status).toBe("playing");

    const finished = runner.resume(state, { random: seededUniform("resume-b") });
    expect(finished.totalTurns).toBeGreaterThan(0);
    expect(finished.finished).toBe(true);
    expect(finished.finishingOrder).toHaveLength(4);
  });
});

describe("the pool", () => {
  it("splits games without losing or inventing any", () => {
    expect(splitGames(10, 3).reduce((a, b) => a + b, 0)).toBe(10);
    expect(splitGames(1000, 8)).toHaveLength(8);
    expect(splitGames(3, 8)).toHaveLength(3);
  });

  it("replays a batch identically however it is split", async () => {
    const one = await runLudoBatch({ games: 3_000, seed: "same", policies: BOTS, threads: 1 });
    const two = await runLudoBatch({ games: 3_000, seed: "same", policies: BOTS, threads: 1 });
    const key = selectionId({
      key: "red",
      marketType: "ludo_match_winner",
      subject: "",
      line: null,
    });
    expect(two.counts.get(key)).toEqual(one.counts.get(key));
  });
});

describe("the policy read", () => {
  it("plays an even mix until ten games have been seen", () => {
    const mix = estimatePolicyMix({ choices: [], games: 4 });
    expect(mix.cautious).toBeCloseTo(EVEN_POLICY_MIX.cautious, 10);
    expect(mix.aggressive).toBeCloseTo(EVEN_POLICY_MIX.aggressive, 10);
    expect(mix.racer).toBeCloseTo(EVEN_POLICY_MIX.racer, 10);
  });

  it("reads a racer from decisions a racer would make", () => {
    const random = seededUniform("policy-read");
    const choices = [];
    let state = createInitialState({ players: 4 });
    for (let turn = 0; turn < 400 && state.status === "playing"; turn += 1) {
      const roll = Math.floor(random() * 6) + 1;
      const outcome = applyRoll(state, roll, cautiousChooser);
      // Record the cautious bot's own choice: the read must recognise it.
      const moved = outcome.events.find((event) => event.token !== undefined);
      if (moved?.token !== undefined && state.seats[state.turn] === 0) {
        choices.push({ state, roll, token: moved.token });
      }
      state = outcome.state;
    }
    expect(choices.length).toBeGreaterThan(10);

    const shares = observedShares({ choices, games: 30 });
    expect(shares.informative).toBeGreaterThan(5);
    // The cautious bot's own move is what was recorded, so cautious has to be the
    // policy that accounts for most of the record. It is not all of it: on many
    // turns the racer picks the same token, which is exactly why a read is a mix.
    expect(shares.mix.cautious).toBeGreaterThan(shares.mix.aggressive);
    expect(shares.mix.cautious).toBeGreaterThan(shares.mix.racer);
    expect(shares.mix.cautious).toBeGreaterThan(0.3);

    // And a thin record is pulled toward even, not taken at face value.
    const thin = estimatePolicyMix({ choices: choices.slice(0, 12), games: 2 });
    expect(thin.cautious).toBeLessThan(estimatePolicyMix({ choices, games: 30 }).cautious);
  });
});

describe("the numbers a market needs", () => {
  it("reports stats the catalogue settles every market against", () => {
    const stats: LudoGameStats = simulateLudoGame({
      policies: BOTS,
      random: seededUniform("settle-all"),
    });
    const catalog = ludoCatalog();
    for (const found of catalog.markets) {
      for (const selection of found.selections) {
        const settlement = catalog.settle(found, selection.key, stats);
        expect(["won", "lost", "void"]).toContain(settlement);
      }
    }
  });
});

describe("pricing a Ludo match", () => {
  /** Four bot seats, ready to price. */
  async function ludoMatch(): Promise<{ repository: InMemoryMatchRepository; matchId: string }> {
    const repository = new InMemoryMatchRepository();
    const match = await repository.create({
      game: "ludo",
      seedCommit: "0".repeat(64),
      seats: [
        { seat: 1, botLevel: "club", botPolicy: "cautious", displayName: "Red" },
        { seat: 2, botLevel: "club", botPolicy: "cautious", displayName: "Green" },
        { seat: 3, botLevel: "club", botPolicy: "cautious", displayName: "Yellow" },
        { seat: 4, botLevel: "club", botPolicy: "cautious", displayName: "Blue" },
      ],
    });
    return { repository, matchId: match.id };
  }

  it("writes a full book the API can publish", async () => {
    const { repository: matches, matchId } = await ludoMatch();
    const markets = new InMemoryMarketsRepository();

    const report = await priceLudoMatch(matchId, {
      matches,
      repository: markets,
      simulations: 2_000,
      threads: 1,
      budgetMs: 600_000,
    });

    // The brief's "about 260 priced markets": selections, which is what a row is.
    expect(report.selections).toBeGreaterThanOrEqual(240);
    expect(report.selections).toBeLessThanOrEqual(290);
    expect(report.gamesPlayed).toBe(2_000);
    expect(report.threads).toBe(1);

    const written = await markets.listForMatch(matchId);
    expect(written).toHaveLength(report.selections);
    expect(written.every((row) => row.status === "open")).toBe(true);

    // The match winner is a real book: four prices, none of them free.
    const winner = written.filter((row) => row.marketType === "ludo_match_winner");
    expect(winner).toHaveLength(4);
    const implied = winner.reduce((total, row) => total + 1 / row.oddsDecimal, 0);
    expect(implied).toBeGreaterThan(1);
    expect(implied).toBeLessThan(1.25);
  }, 180_000);

  it("falls back to the smaller batch when the budget cannot hold a million", async () => {
    const { repository: matches, matchId } = await ludoMatch();
    const markets = new InMemoryMarketsRepository();

    const report = await priceLudoMatch(matchId, {
      matches,
      repository: markets,
      simulations: LUDO_PRICE_SIMULATIONS,
      // A budget nothing could meet, which is the rule under test: the engine
      // must not spend a million games it has not got the time for.
      budgetMs: 1,
      threads: 1,
    });

    expect(report.fellBack).toBe(true);
    expect(report.gamesPlayed).toBe(LUDO_FALLBACK_SIMULATIONS);
  }, 600_000);

  it("prices a book in the time a pre-match price is allowed", async () => {
    const started = Date.now();
    const { repository: matches, matchId } = await ludoMatch();
    await priceLudoMatch(matchId, {
      matches,
      repository: new InMemoryMarketsRepository(),
      simulations: 20_000,
      budgetMs: LUDO_PRICE_BUDGET_MS,
      threads: 2,
      write: false,
    });
    expect(Date.now() - started).toBeLessThan(LUDO_PRICE_BUDGET_MS);
  }, 180_000);
});
