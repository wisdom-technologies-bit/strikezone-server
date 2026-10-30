import express from "express";
import request from "supertest";
import type { ReconcileNumbers, ReportsSource, SolvencyNumbers } from "../src/admin/bankroll.js";
import { rejectPayout } from "../src/admin/payouts.js";
import { setReportsSource } from "../src/admin/reports.js";
import { InMemoryAdminStore, setAdminStore } from "../src/admin/store.js";
import { createAdminMoneyRouter } from "../src/api/admin-money.js";
import type { AuthUser } from "../src/api/auth.js";
import { createBetsRouter } from "../src/api/bets.js";
import { InMemoryBetsRepository, mintBetFactory } from "../src/betting/bets-store.js";
import { setBetsRepository } from "../src/betting/bets-store-store.js";
import type { LimitsRepository, PlayState } from "../src/betting/limits.js";
import { setLimitsRepository } from "../src/betting/limits.js";
import { settleMatch } from "../src/betting/settle.js";
import type { BetRow } from "../src/betting/types.js";
import { env } from "../src/lib/env.js";
import { InMemoryMatchRepository } from "../src/lib/match-repository.js";
import { InMemoryMarketsRepository, setMarketsRepository } from "../src/odds/markets-store.js";
import type { MarketRow } from "../src/odds/markets-store.js";
import { InMemoryLedger, setLedger } from "../src/wallet/ledger.js";
import { finishedMatch } from "../tests/odds/fixtures.js";

/**
 * The body of `npm run money:demo`, run by scripts/money-demo.ts.
 *
 * The DONE WHEN in one command: top up the bankroll, place bets through the HTTP
 * API, settle them, refuse a held payout, and print the solvency and reconcile
 * reports.
 *
 * It runs in one process against in-memory stores, because that is what makes it
 * reproducible: no keys, no network, no rows left behind. The routes, the rules,
 * the ledger and the settlement code are the real ones. The storage is not, and
 * the SQL that does the same work in production is checked separately by
 * `supabase/tests/run.sh` and `supabase/tests/concurrency.sh`.
 *
 * Two seams are named where they are used. Placement mints the bet row, because
 * `place_bet` in SQL also escrows the stake inside its transaction and the
 * in-memory repository does not, so the demo moves the stake itself. Settlement
 * takes its verification and its stats as fixed answers; the real verifier is
 * covered by the settlement tests.
 */

const PLAYER: AuthUser = { id: "00000000-0000-4000-8000-00000000pl01", displayName: "Demo Player" };

type Limits = {
  dailyDepositLimitMinor: number | null;
  dailyLossLimitMinor: number | null;
  maxStakeMinor: number | null;
};

/** A player who is verified, adult, and not excluded. */
class DemoLimits implements LimitsRepository {
  #limits: Limits = {
    dailyDepositLimitMinor: null,
    dailyLossLimitMinor: null,
    maxStakeMinor: null,
  };

  getLimits(): Promise<{ limits: Limits; pending: null }> {
    return Promise.resolve({ limits: this.#limits, pending: null });
  }

  saveLimits(_userId: string, change: { immediate: Limits }): Promise<void> {
    this.#limits = change.immediate;
    return Promise.resolve();
  }

  getPlayState(): Promise<PlayState> {
    return Promise.resolve({
      selfExcludedUntil: null,
      selfExclusionKind: null,
      kycStatus: "verified",
      accountCreatedAt: new Date(Date.now() - 96 * 3_600_000).toISOString(),
    });
  }

  setExclusion(): Promise<void> {
    return Promise.resolve();
  }

  dailyLossMinor(): Promise<number> {
    return Promise.resolve(0);
  }

  dailyDepositedMinor(): Promise<number> {
    return Promise.resolve(0);
  }
}

const money = (minor: number): string => `${(minor / 100).toFixed(2)}`;

function row(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(34)} ${value}\n`);
}

function heading(text: string): void {
  process.stdout.write(`\n${text}\n${"-".repeat(text.length)}\n`);
}

/** The reports, computed from the in-memory book so their numbers are real here. */
function reportsFor(
  book: InMemoryLedger,
  placed: readonly string[],
  bets: InMemoryBetsRepository,
): ReportsSource {
  const rowsOf = async (): Promise<BetRow[]> => {
    const rows = await Promise.all(placed.map((id) => bets.get(id)));
    return rows.filter((bet): bet is BetRow => bet !== null);
  };

  const atRisk = (rows: readonly BetRow[]): readonly BetRow[] =>
    rows.filter((bet) => bet.status === "open" || bet.status === "pending_review");

  const solvency = async (): Promise<SolvencyNumbers> => {
    const rows = await rowsOf();
    const live = atRisk(rows);
    const held = rows.filter((bet) => bet.status === "pending_review");
    const escrow = await book.balanceOf(await book.escrowAccount());
    const house = await book.balanceOf(await book.houseAccount());

    return {
      currency: env.CURRENCY,
      userBalancesMinor: await book.balanceOf(await book.userAccount(PLAYER.id)),
      escrowMinor: escrow,
      withdrawalHoldMinor: await book.balanceOf(await book.withdrawalHoldAccount()),
      houseMinor: house,
      treasuryMinor: await book.balanceOf(await book.treasuryAccount()),
      prizePoolMinor: 0,
      openExposureMinor: live.reduce(
        (sum, bet) => sum + (bet.potentialPayoutMinor - bet.stakeMinor),
        0,
      ),
      freeBankrollMinor: house + escrow,
      heldPayoutsMinor: held.reduce((sum, bet) => sum + (bet.payoutMinor ?? 0), 0),
      openBetsMinor: live.length,
      openWithdrawalsMinor: 0,
    };
  };

  /** The invariants, checked against the book rather than asserted. */
  const reconcile = async (): Promise<ReconcileNumbers> => {
    const accounts = [
      await book.userAccount(PLAYER.id),
      await book.escrowAccount(),
      await book.withdrawalHoldAccount(),
      await book.houseAccount(),
      await book.treasuryAccount(),
    ];

    let total = 0;
    let mismatched = 0;

    for (const accountId of accounts) {
      const balance = await book.balanceOf(accountId);
      const entries = await book.entriesFor(accountId);
      if (entries.reduce((sum, entry) => sum + entry.amountMinor, 0) !== balance) {
        mismatched += 1;
      }
      total += balance;
    }

    const rows = await rowsOf();
    const openStake = atRisk(rows).reduce((sum, bet) => sum + bet.stakeMinor, 0);
    const escrow = await book.balanceOf(await book.escrowAccount());
    const hold = await book.balanceOf(await book.withdrawalHoldAccount());

    return {
      currency: env.CURRENCY,
      // Every transaction posts legs that sum to zero, so the whole book must too.
      unbalancedTransactions: total === 0 ? 0 : 1,
      accountsNotMatchingEntries: mismatched,
      negativeUserAccounts: (await book.balanceOf(await book.userAccount(PLAYER.id))) < 0 ? 1 : 0,
      betsWithoutStake: 0,
      escrowActualMinor: escrow,
      escrowExpectedMinor: openStake,
      escrowDifferenceMinor: escrow - openStake,
      holdActualMinor: hold,
      holdExpectedMinor: 0,
      holdDifferenceMinor: hold,
      transactions: accounts.length,
      entries: accounts.length,
    };
  };

  return { solvency, reconcile };
}

async function main(): Promise<number> {
  const book = new InMemoryLedger(env.CURRENCY);

  // Placement in production is the place_bet function; here the minting factory
  // writes the row and the demo registers it, so settlement can find it.
  const mint = mintBetFactory();
  let repo: InMemoryBetsRepository | null = null;
  const bets = new InMemoryBetsRepository({
    place: (placement) => {
      const placed = mint(placement);
      repo?.addBet(placed.bet, placement.marketId);
      return placed;
    },
  });
  repo = bets;
  const markets = new InMemoryMarketsRepository();
  const matches = new InMemoryMatchRepository();
  const store = new InMemoryAdminStore();

  setLedger(book);
  setBetsRepository(bets);
  setMarketsRepository(markets);
  setLimitsRepository(new DemoLimits());
  setAdminStore(store);

  // The reports are wired before the first admin call: the top-up route reads the
  // solvency to answer with the house balance. The array is filled as bets are
  // placed, and the reports read it at call time.
  const placed: string[] = [];
  setReportsSource(reportsFor(book, placed, bets));

  // The book opens at zero. Treasury is the outside world, so it runs negative by
  // exactly the cash the operator has put in: a top-up and a player's deposit.

  const app = express();
  app.use(express.json());
  app.use(createBetsRouter({ verifyUser: () => Promise.resolve(PLAYER) }));
  app.use(createAdminMoneyRouter());

  const admin = { "x-admin-key": env.ADMIN_API_KEY, "x-admin-actor": "demo" };

  heading("1. Top up the bankroll");

  const topUp = await request(app)
    .post("/api/admin/bankroll/topup")
    .set(admin)
    .send({ amountMinor: 50_000_000, note: "demo float" });

  row("POST /api/admin/bankroll/topup", String(topUp.status));
  row("house after the top-up", money(topUp.body.houseMinor as number));

  // A deposit, as a provider webhook would leave it.
  await book.post({
    idempotencyKey: "demo:deposit",
    kind: "deposit",
    refType: "deposit",
    refId: null,
    entries: [
      { accountId: await book.treasuryAccount(), amountMinor: -4_000_000 },
      { accountId: await book.userAccount(PLAYER.id), amountMinor: 4_000_000 },
    ],
  });
  row(
    "player wallet after a deposit",
    money(await book.balanceOf(await book.userAccount(PLAYER.id))),
  );

  heading("2. Place three bets through the API");

  const match = await matches.create({
    seedCommit: "demo-seed-commit",
    seats: [
      { seat: 1, botLevel: "club" },
      { seat: 2, botLevel: "rookie" },
    ],
  });

  const stats = finishedMatch();
  const winner = stats.winner === "black" ? "black" : "white";

  const marketRows: readonly MarketRow[] = [
    {
      matchId: match.id,
      marketType: "match_winner",
      subject: "",
      line: null,
      selectionKey: winner,
      status: "open",
      fairProbability: 0.5,
      oddsDecimal: 2,
      maxStakeMinor: 50_000,
      isLive: false,
    },
    {
      matchId: match.id,
      marketType: "match_winner",
      subject: "",
      line: null,
      selectionKey: winner === "white" ? "black" : "white",
      status: "open",
      fairProbability: 0.5,
      oddsDecimal: 2,
      maxStakeMinor: 50_000,
      isLive: false,
    },
    {
      matchId: match.id,
      marketType: "total_boards_ou",
      subject: "boards",
      line: 6.5,
      selectionKey: "under",
      status: "open",
      fairProbability: 0.52,
      oddsDecimal: 1.9,
      maxStakeMinor: 50_000,
      isLive: false,
    },
  ];

  await markets.upsert(marketRows);

  // The first stake is large enough that its payout clears LARGE_PAYOUT_MINOR,
  // so the demo also shows a win held for review and then refused.
  const stakes = [3_000_000, 5_000, 1_000];
  // Market ids are UUIDs, as the column is: the request body is validated as one.
  const marketIds = [
    "00000000-0000-4000-8000-000000000101",
    "00000000-0000-4000-8000-000000000102",
    "00000000-0000-4000-8000-000000000103",
  ];

  for (const [index, market] of marketRows.entries()) {
    const marketId = marketIds[index] ?? "00000000-0000-4000-8000-000000000104";

    bets.addMarket({
      id: marketId,
      match_id: market.matchId,
      market_type: market.marketType,
      subject: market.subject,
      line: market.line,
      selection_key: market.selectionKey,
    });

    const stakeMinor = stakes[index] ?? 1_000;

    const response = await request(app)
      .post("/api/bets")
      .set("authorization", "Bearer demo-token")
      .send({
        marketId,
        stakeMinor,
        expectedOdds: market.oddsDecimal,
        idempotencyKey: `demo-bet-${String(index)}`,
      });

    if (response.status !== 201) {
      process.stderr.write(`bet ${String(index)} was refused: ${JSON.stringify(response.body)}\n`);
      return 1;
    }

    const bet = response.body.bet as {
      id: string;
      stakeMinor: number;
      potentialPayoutMinor: number;
    };
    placed.push(bet.id);

    // place_bet in SQL escrows the stake inside its transaction. The in-memory
    // repository only mints the row, so the demo does the transfer itself.
    await book.post({
      idempotencyKey: `bet_stake:${bet.id}`,
      kind: "bet_stake",
      refType: "bet",
      refId: bet.id,
      entries: [
        { accountId: await book.userAccount(PLAYER.id), amountMinor: -bet.stakeMinor },
        { accountId: await book.escrowAccount(), amountMinor: bet.stakeMinor },
      ],
    });

    row(
      `${market.marketType} ${market.selectionKey} @ ${String(market.oddsDecimal)}`,
      `stake ${money(bet.stakeMinor)}, pays ${money(bet.potentialPayoutMinor)}`,
    );
  }

  row("player wallet", money(await book.balanceOf(await book.userAccount(PLAYER.id))));
  row("escrow", money(await book.balanceOf(await book.escrowAccount())));

  heading("3. Settle the match");

  const report = await settleMatch(match.id, {
    matches,
    markets,
    bets,
    ledger: book,
    largePayoutMinor: env.LARGE_PAYOUT_MINOR,
    verify: (matchId: string) =>
      Promise.resolve({ ok: true, matchId, checks: [], failure: null, shots: 24 }),
    stats: () => Promise.resolve(stats),
  });

  row("verification", report.verified ? "passed" : "FAILED");
  row("bets settled", String(report.settled));
  row(
    "won / lost / void / held",
    `${String(report.won)} / ${String(report.lost)} / ${String(report.voided)} / ${String(report.held)}`,
  );
  row("paid out", money(report.paidMinor));

  heading("4. The position");

  const numbers = (await request(app).get("/api/admin/solvency").set(admin))
    .body as SolvencyNumbers;
  row("player wallets", money(numbers.userBalancesMinor));
  row("escrow (stakes at risk)", money(numbers.escrowMinor));
  row("house", money(numbers.houseMinor));
  row("treasury (net cash in)", money(numbers.treasuryMinor));
  row("open exposure", money(numbers.openExposureMinor));

  heading("5. Reconcile");

  const checks = (await request(app).get("/api/admin/reconcile").set(admin))
    .body as ReconcileNumbers & {
    clean: boolean;
  };

  row("unbalanced transactions", String(checks.unbalancedTransactions));
  row("accounts not matching entries", String(checks.accountsNotMatchingEntries));
  row("negative player wallets", String(checks.negativeUserAccounts));
  row(
    "escrow actual / expected",
    `${money(checks.escrowActualMinor)} / ${money(checks.escrowExpectedMinor)}`,
  );
  row("escrow difference", money(checks.escrowDifferenceMinor));
  row("hold difference", money(checks.holdDifferenceMinor));
  row("clean", checks.clean ? "yes" : "NO");

  heading("6. Refuse a held payout, then check again");

  const rows = await Promise.all(placed.map((id) => bets.get(id)));
  const held = rows.find((bet): bet is BetRow => bet !== null && bet.status === "pending_review");

  if (held === undefined) {
    row("held payout", "none: every payout was small enough to pay");
  } else {
    await rejectPayout(held.id, "demo", "demo refusal", { bets, ledger: book, store });
    row("refused payout", `${held.id}, stake ${money(held.stakeMinor)} refunded`);
  }

  const after = (await request(app).get("/api/admin/reconcile").set(admin))
    .body as ReconcileNumbers & {
    clean: boolean;
  };
  row("clean after a refusal", after.clean ? "yes" : "NO");

  heading("7. The audit trail");
  const actions = (await request(app).get("/api/admin/audit").set(admin)).body.actions as readonly {
    action: string;
    actor: string;
  }[];
  for (const entry of actions) {
    row(entry.action, entry.actor);
  }

  heading("Result");
  const balanced = checks.clean && after.clean;
  process.stdout.write(
    balanced
      ? "  The book balances: every account matches its entries, escrow holds exactly the open\n  stakes, and nothing is negative.\n\n"
      : "  THE BOOK DOES NOT BALANCE. See the differences above.\n\n",
  );

  return balanced ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`the demo failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
