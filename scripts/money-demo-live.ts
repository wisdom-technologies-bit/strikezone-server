/**
 * npm run money:demo:live
 *
 * The end to end against the real database: a Ludo match played and logged by the
 * real runner, priced by the real Ludo pricer, a real bet placed through
 * `place_bet`, a real settlement with the real verifier, and the solvency and
 * reconcile reports read back from the live ledger.
 *
 * Nothing here is seeded with a fixed answer except the simulated games the price
 * is made of, which are seeded from the match id so a re-run reproduces them.
 * Unlike `npm run money:demo`, this leaves rows behind: it writes one match, its
 * events, its markets, one bet and the ledger entries that settle it. Point it at
 * a project you do not mind filling with a demo match.
 *
 * It refuses to run when SUPABASE_URL still points at the demo placeholder.
 */

import { env } from "../src/lib/env.js";
import { supabase } from "../src/lib/supabase.js";
import { commitOf, createMatchSeed } from "../src/lib/fair-rng.js";
import { logger } from "../src/lib/logger.js";
import { matchRepository } from "../src/lib/match-store.js";
import { marketsRepository } from "../src/odds/markets-store.js";
import { priceLudoMatch } from "../src/odds/ludo-pricer.js";
import { LudoMatchRunner, type LudoRunnerSeat } from "../src/rooms/ludo-match-runner.js";
import { placeBet } from "../src/betting/place.js";
import { settleMatch } from "../src/betting/settle.js";
import { reportsSource } from "../src/admin/reports.js";
import { ledger } from "../src/wallet/ledger.js";
import { ledgerCurrency } from "../src/wallet/payments.js";

/**
 * Four distinct bots.
 *
 * A bot is a stable identity keyed on its display name, so seating four bots of
 * one level would seat one player four times, and match_players refuses that. Each
 * seat names its own bot and carries its own policy.
 */
const SEATS: readonly {
  readonly seat: 1 | 2 | 3 | 4;
  readonly policy: string;
  readonly name: string;
}[] = [
  { seat: 1, policy: "cautious", name: "Cautious Bot" },
  { seat: 2, policy: "aggressive", name: "Aggressive Bot" },
  { seat: 3, policy: "racer", name: "Racer Bot" },
  { seat: 4, policy: "cautious", name: "Steady Bot" },
];

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

async function ensurePlayer(): Promise<{ readonly id: string; readonly username: string }> {
  const existing = await supabase
    .from("profiles")
    .select("id, username")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string; username: string }>();

  if (existing.error !== null) {
    fail(`could not read the profiles: ${existing.error.message}`);
  }
  if (existing.data !== null) {
    return existing.data;
  }

  // No profile yet: the demo makes itself a player. `auth.users` is the parent
  // row, so the account is created through the admin API and the profile follows.
  const username = `demo-player-${Date.now().toString(36)}`;
  const created = await supabase.auth.admin.createUser({
    email: `${username}@strikezone.test`,
    password: `demo-${username}-${String(Date.now())}-password`,
    email_confirm: true,
  });

  if (created.error !== null || created.data.user === null) {
    fail(`could not create the demo player: ${created.error?.message ?? "no user returned"}`);
  }

  const inserted = await supabase
    .from("profiles")
    .upsert({ id: created.data.user.id, username }, { onConflict: "id" })
    .select("id, username")
    .single<{ id: string; username: string }>();

  if (inserted.error !== null) {
    fail(`could not write the demo profile: ${inserted.error.message}`);
  }
  return inserted.data;
}

async function main(): Promise<void> {
  if (env.SUPABASE_URL.includes("demo-project")) {
    fail("SUPABASE_URL is the demo placeholder: run this against a real project");
  }

  const player = await ensurePlayer();
  console.log(`player      ${player.username} (${player.id})`);

  // 1. A real match, played by the real runner and logged to match_events.
  const repository = matchRepository();
  const seed = createMatchSeed();
  const match = await repository.create({
    game: "ludo",
    seedCommit: commitOf(seed),
    seats: SEATS.map((entry) => ({
      seat: entry.seat,
      botLevel: "club" as const,
      botPolicy: entry.policy,
      displayName: entry.name,
    })),
    config: { ludo: { players: 4 } },
  });

  const seats: LudoRunnerSeat[] = [...match.seats]
    .sort((left, right) => left.seat - right.seat)
    .map((seat) => ({
      seat: seat.seat,
      playerId: seat.playerId,
      displayName: seat.displayName,
      isBot: seat.isBot,
      botPolicy: seat.botPolicy,
      profileId: seat.profileId,
    }));

  let finished: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => {
    finished = resolve;
  });

  const runner = new LudoMatchRunner({
    matchId: match.id,
    seed,
    seedCommit: commitOf(seed),
    seats,
    repository,
    config: { players: 4 },
    botDelayMs: { min: 0, max: 1 },
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
    logger: logger.child({ demo: "live" }),
    hooks: {
      onEnd: () => {
        finished?.();
      },
    },
  });

  console.log(`match       ${match.id}, four bots, seed committed before play`);
  await runner.start();
  await ended;

  const finishedMatch = await repository.get(match.id);
  const winnerSeat = finishedMatch?.result?.winnerSeat ?? null;
  console.log(
    `finished    ${String(finishedMatch?.result?.shots ?? 0)} moves, winner seat ${String(winnerSeat)}`,
  );

  // 2. The Ludo price, written to the markets table.
  const priced = await priceLudoMatch(match.id, { simulations: 20_000, budgetMs: 600_000 });
  console.log(
    `priced      ${String(priced.selections)} selections from ${String(priced.gamesPlayed)} games on ${String(priced.threads)} threads in ${String(Math.round(priced.elapsedMs))} ms${priced.fellBack ? " (fell back to fit the budget)" : ""}`,
  );

  const rows = await marketsRepository().listForMatch(match.id);
  console.log(
    `markets     ${String(new Set(rows.map((row) => row.marketType)).size)} types, ${String(rows.length)} rows in the database`,
  );

  // 3. A bet on the seat that actually won, so the payout is exercised.
  // Seats are numbered from one, the colour list from zero.
  const seatName = ["red", "green", "yellow", "blue"][(winnerSeat ?? 1) - 1] ?? "red";
  const row = rows.find(
    (each) => each.marketType === "ludo_match_winner" && each.selectionKey === seatName,
  );
  if (row === undefined) {
    fail(`no winner market for ${seatName}`);
  }

  // The row shapes the price reports do not carry the database id, which is what
  // placement wants, so the id is read back from the table it was written to.
  const stored = await supabase
    .from("markets")
    .select("id, odds_decimal")
    .eq("match_id", match.id)
    .eq("market_type", "ludo_match_winner")
    .eq("subject", "")
    .eq("selection_key", seatName)
    .maybeSingle<{ id: string; odds_decimal: number }>();

  if (stored.error !== null || stored.data === null) {
    fail(`could not read the market row: ${stored.error?.message ?? "not found"}`);
  }
  const target = { id: stored.data.id, oddsDecimal: stored.data.odds_decimal };

  const book = ledger();

  // The escrow account is a singleton row that place_bet refuses to work without.
  // Reading it creates it, which is what the first real bet on a fresh project
  // needs; the deposit below then funds the player and the house.
  const escrow = await book.escrowAccount();
  console.log(`escrow      ${escrow}`);

  await book.post({
    idempotencyKey: `live-demo:treasury:${match.id}`,
    kind: "deposit",
    refType: "deposit",
    refId: null,
    entries: [
      { accountId: await book.treasuryAccount(), amountMinor: -60_000_000 },
      { accountId: await book.houseAccount(), amountMinor: 50_000_000 },
      { accountId: await book.userAccount(player.id), amountMinor: 10_000_000 },
    ],
  });

  const placed = await placeBet(
    player.id,
    {
      marketId: target.id,
      stakeMinor: 10_000,
      expectedOdds: target.oddsDecimal,
      idempotencyKey: `live-demo:bet:${match.id}`,
    },
    {},
  );
  console.log(
    `bet         ${placed.bet.id} 10,000 at ${String(target.oddsDecimal)} on ${seatName}`,
  );

  // 4. Settlement: the real verifier, the real Ludo facts, the real money.
  const report = await settleMatch(match.id, {
    matches: repository,
    markets: marketsRepository(),
  });
  console.log(
    `settled     verified=${String(report.verified)} settled=${String(report.settled)} won=${String(report.won)} lost=${String(report.lost)} voided=${String(report.voided)} paid=${String(report.paidMinor)}`,
  );

  const settledBet = await supabase
    .from("bets")
    .select("status, payout_minor")
    .eq("id", placed.bet.id)
    .single<{ status: string; payout_minor: number | null }>();
  console.log(
    `bet row     ${settledBet.data?.status ?? "?"} paid ${String(settledBet.data?.payout_minor ?? 0)}`,
  );

  // 5. The books, read from the live ledger.
  const reports = reportsSource();
  // The currency the ledger actually keeps, not the one the environment names.
  // In virtual mode the ledger is XTS while env.CURRENCY is NGN, so reporting on
  // env.CURRENCY read an empty set of books and called a healthy escrow a 30,000
  // shortfall.
  const solvency = await reports.solvency(ledgerCurrency());
  const reconcile = await reports.reconcile(ledgerCurrency());

  console.log("");
  console.log(
    `solvency    free=${String(solvency.freeBankrollMinor)} escrow=${String(solvency.escrowMinor)} user=${String(solvency.userBalancesMinor)} house=${String(solvency.houseMinor)}`,
  );
  console.log(
    `reconcile   unbalanced=${String(reconcile.unbalancedTransactions)} accounts=${String(reconcile.accountsNotMatchingEntries)} negative=${String(reconcile.negativeUserAccounts)} stakes=${String(reconcile.betsWithoutStake)} escrowDiff=${String(reconcile.escrowDifferenceMinor)} holdDiff=${String(reconcile.holdDifferenceMinor)}`,
  );

  const clean =
    reconcile.unbalancedTransactions === 0 &&
    reconcile.accountsNotMatchingEntries === 0 &&
    reconcile.negativeUserAccounts === 0 &&
    reconcile.betsWithoutStake === 0 &&
    reconcile.escrowDifferenceMinor === 0 &&
    reconcile.holdDifferenceMinor === 0;

  if (!report.verified) {
    fail(`settlement did not verify: ${report.voidReason ?? "unknown"}`);
  }
  if (settledBet.data?.status !== "won") {
    fail(`the winning bet is ${settledBet.data?.status ?? "missing"}, not won`);
  }
  if (!clean) {
    fail("the book does not reconcile");
  }

  console.log("");
  console.log(`PASS ${match.id}: match verified, markets priced, bet won, book reconciles to zero`);
}

await main();
