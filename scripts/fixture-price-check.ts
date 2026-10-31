import { randomUUID } from "node:crypto";
import { InMemoryMatchRepository } from "../src/lib/match-repository.js";
import { InMemoryMarketsRepository } from "../src/odds/markets-store.js";
import { carromFixture, ludoFixture } from "../src/fixtures/roster.js";
import { priceFixture } from "../src/fixtures/pricing.js";
import { fixtureSeedCommit } from "../src/fixtures/seed.js";

/**
 * What a fixture costs to price, in time and in numbers.
 *
 * Runs the same pricing the scheduler runs, against an in-memory store, and
 * prints the counts an operator wants when deciding whether the host can afford
 * the full simulation count: how many were used, whether the budget forced the
 * reduced count, how long it took, and the prices that came out on the headline
 * market. No database is touched and nothing is written anywhere but memory.
 */

const matches = new InMemoryMatchRepository();
const markets = new InMemoryMarketsRepository();
const secret = "fixture-price-check-secret-0123456789abcdef";

for (const plan of [carromFixture(0), ludoFixture(0)]) {
  const id = randomUUID();
  const match = await matches.create({
    id,
    game: plan.game,
    seedCommit: fixtureSeedCommit(id, secret),
    seats: plan.seats,
    config: plan.config,
    scheduledAt: new Date().toISOString(),
  });

  const report = await priceFixture(match.id, plan.game, { matches, markets });
  const rows = await markets.listForMatch(match.id);
  const headline = rows.filter(
    (row) => row.marketType === (plan.game === "ludo" ? "ludo_match_winner" : "match_winner"),
  );

  console.log(`game        ${plan.game}`);
  console.log(`seats       ${plan.seats.map((seat) => seat.displayName).join(" vs ")}`);
  console.log(
    `simulations ${String(report.simulations)}${report.reduced ? " (reduced to fit the budget)" : ""}`,
  );
  console.log(`elapsed     ${String(Math.round(report.elapsedMs))} ms`);
  console.log(
    `markets     ${String(rows.length)} selections, ${String(new Set(rows.map((r) => r.marketType)).size)} types`,
  );
  console.log(
    `headline    ${headline.map((row) => `${row.selectionKey} ${row.oddsDecimal.toFixed(2)}`).join(", ")}`,
  );
  console.log("");
}
