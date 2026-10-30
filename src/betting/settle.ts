import { subscribe } from "../lib/events.js";
import { raiseAlert } from "../monitoring/alerts.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { verifyMatch } from "../lib/match-verify.js";
import { verifyLudoMatch } from "../lib/match-verify-ludo.js";
import type { MatchRecord, MatchRepository } from "../lib/match-repository.js";
import { carromCatalog, type CarromCatalog, type Settlement } from "../odds/catalog/carrom.js";
import { ludoCatalog } from "../odds/catalog/ludo.js";
import { replayLudoLog } from "../odds/ludo-stats.js";
import type { MarketsRepository } from "../odds/markets-store.js";
import type { Ledger } from "../wallet/ledger.js";
import { ledger } from "../wallet/ledger.js";
import type { BetsRepository } from "./bets-store.js";
import { betsRepository } from "./bets-store-store.js";
import {
  FORFEIT_SETTLED_MARKETS,
  planSettlement,
  settlesOnForfeit,
  wholeMatchVoidReason,
  type VoidReason,
} from "./rules.js";
import type { BetWithMarket } from "./types.js";
import { computeMatchStats, type MatchStats } from "../odds/stats.js";
import type { LudoGameStats } from "../odds/ludo-stats.js";

/**
 * Settlement: turning a verified match into decided bets and moved money.
 *
 * The order is deliberate and never varies:
 *
 * 1. Verify the match first. The signature, the hash chain and a full replay of
 *    every shot. If any check fails nothing settles, the match is flagged and the
 *    operator is told. A settlement that can be steered by an unverified result
 *    is worse than no settlement.
 * 2. Decide each bet with the catalogue's own outcome function, so the market
 *    that was priced and the market that was settled are the same market.
 * 3. Move the money through the ledger with one idempotency key per bet, then
 *    write the bet's status. Both steps are idempotent, so a re-run is a no-op.
 * 4. Close the markets: settled, or void when the match itself was void.
 *
 * A payout above LARGE_PAYOUT_MINOR is not paid here. It becomes pending_review
 * and waits for an admin, with the money still in escrow.
 */

export interface SettlementDeps {
  readonly matches: MatchRepository;
  readonly markets: MarketsRepository;
  readonly bets?: BetsRepository;
  readonly ledger?: Ledger;
  readonly catalog?: CarromCatalog;
  readonly secret?: string;
  readonly largePayoutMinor?: number;
  readonly now?: () => Date;
  /** Where a flagged match is reported. Defaults to the logger. */
  readonly alert?: (message: string, context: Readonly<Record<string, unknown>>) => void;
  /**
   * Verifies the match. Defaults to the real verifier, and exists as a seam so
   * settlement can be tested without signing a whole match. Payment code never
   * overrides it.
   */
  readonly verify?: (matchId: string, matches: MatchRepository) => Promise<VerificationOutcome>;
  /** The stats a market settles against. Defaults to the events in the database. */
  readonly stats?: (matchId: string, match: MatchRecord) => Promise<MatchStats>;
  /** The same seam for a Ludo match, whose facts are a different shape. */
  readonly ludoStats?: (matchId: string, match: MatchRecord) => Promise<LudoGameStats>;
}

/** What verification reports. */
export type VerificationOutcome = Awaited<ReturnType<typeof verifyMatch>>;

/**
 * A whole-match check as settlement needs it: did it verify, why not, and how
 * much of it happened. Both verifiers report this, with their own `shots` count
 * for Carrom and turns for Ludo.
 */
function verificationShots(shots: unknown): number {
  if (typeof shots === "number") {
    return shots;
  }
  return Array.isArray(shots) ? shots.length : 0;
}

/** What one settlement run did. */
export interface SettlementReport {
  readonly matchId: string;
  readonly verified: boolean;
  readonly failure: string | null;
  readonly flagged: boolean;
  readonly voidReason: VoidReason;
  readonly settled: number;
  readonly held: number;
  readonly voided: number;
  readonly won: number;
  readonly lost: number;
  readonly paidMinor: number;
  readonly marketsClosed: number;
}

const EMPTY_REPORT = (matchId: string, fields: Partial<SettlementReport>): SettlementReport => ({
  matchId,
  verified: false,
  failure: null,
  flagged: false,
  voidReason: null,
  settled: 0,
  held: 0,
  voided: 0,
  won: 0,
  lost: 0,
  paidMinor: 0,
  marketsClosed: 0,
  ...fields,
});

/** The outcome of a market whose every bet is void. */
const VOID: Settlement = "void";

/**
 * Settles every open bet on a match, once.
 *
 * Safe to call repeatedly: a settled bet is no longer open, and every ledger
 * movement is keyed by the bet id.
 */
export async function settleMatch(
  matchId: string,
  deps: SettlementDeps,
): Promise<SettlementReport> {
  const bets = deps.bets ?? betsRepository();
  const book = deps.ledger ?? ledger();
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const largePayoutMinor = deps.largePayoutMinor ?? env.LARGE_PAYOUT_MINOR;
  const alert =
    deps.alert ??
    ((message, context) => {
      logger.error({ matchId, ...context }, message);
      // A settlement that fails is money the book owes and has not paid: it is
      // written to the alerts table as well as the log, so it outlives the log.
      void raiseAlert({
        code: "settlement_failed",
        severity: "critical",
        message,
        context: { ...context, game: match?.game ?? "unknown" },
        matchId,
      });
    });

  // 1. Which game, so the right verifier, catalogue and facts are used. A Ludo
  //    match has four seats and a different log; settling it with Carrom's
  //    reader would void every market it has.
  const match = await deps.matches.get(matchId);
  if (match === null) {
    return EMPTY_REPORT(matchId, { failure: "no such match" });
  }
  const game: "carrom" | "ludo" = match.game === "ludo" ? "ludo" : "carrom";

  // 2. Verification, before anything else.
  const verify =
    deps.verify ??
    ((id: string, matches: MatchRepository) =>
      game === "ludo"
        ? verifyLudoMatch(match, matches, { secret: deps.secret ?? env.RESULT_SIGNING_SECRET })
        : verifyMatch(id, matches, { secret: deps.secret ?? env.RESULT_SIGNING_SECRET }));

  const verification = await verify(matchId, deps.matches);

  if (!verification.ok) {
    const failure = verification.failure ?? "verification failed";
    await bets.flagMatch(matchId, failure, at);
    alert("settlement refused: the match did not verify", { failure, checks: verification.checks });
    return EMPTY_REPORT(matchId, { failure, flagged: true });
  }

  const settleBet = await settlementFor(game, matchId, match, deps);

  // 3. Which whole-match rule applies, if any.
  const voidReason = wholeMatchVoidReason(match, verificationShots(verification.shots));
  const forfeit = match.result?.reason === "forfeit";

  const openBets = (await bets.listForMatch(matchId)).filter((bet) => bet.status === "open");

  let settled = 0;
  let held = 0;
  let voided = 0;
  let won = 0;
  let lost = 0;
  let paidMinor = 0;

  for (const bet of openBets) {
    const outcome = decide(bet, { voidReason, forfeit }, settleBet);
    const plan = planSettlement(bet, outcome, largePayoutMinor);

    if (plan.hold) {
      // Decided, owed, not paid: the money stays in escrow until an admin looks.
      await bets.settle(bet.id, {
        status: "pending_review",
        result: plan.outcome,
        payoutMinor: plan.payoutMinor,
        settledAt: at,
        reviewReason: "large_payout",
      });
      held += 1;
      continue;
    }

    await moveMoney(book, bet, plan.outcome, plan.payoutMinor, at);
    await bets.settle(bet.id, {
      status: outcomeToStatus(plan.outcome),
      result: plan.outcome,
      payoutMinor: plan.payoutMinor,
      settledAt: at,
    });

    settled += 1;
    if (plan.outcome === "void" || plan.outcome === "push") {
      voided += 1;
    } else if (plan.outcome === "won") {
      won += 1;
    } else {
      lost += 1;
    }
    paidMinor += plan.payoutMinor;
  }

  // 3. The markets follow the bets.
  const marketsClosed = await closeMarkets(matchId, deps.markets, voidReason, forfeit);

  logger.info(
    { matchId, settled, held, voided, won, lost, paidMinor, marketsClosed },
    "settled the match",
  );

  return {
    matchId,
    verified: true,
    failure: null,
    flagged: false,
    voidReason,
    settled,
    held,
    voided,
    won,
    lost,
    paidMinor,
    marketsClosed,
  };
}

/** One bet's outcome, from the void rules and the catalogue. */
function decide(
  bet: BetWithMarket,
  context: {
    readonly voidReason: VoidReason;
    readonly forfeit: boolean;
  },
  settle: (bet: BetWithMarket) => Settlement,
): Settlement {
  if (context.voidReason !== null) {
    return VOID;
  }
  // A forfeit decides the winner and voids the rest: the match was not played
  // as advertised, so a market about how it was played has no answer.
  if (context.forfeit && !settlesOnForfeit(bet.marketType)) {
    return VOID;
  }
  return settle(bet);
}

/**
 * How one bet of this game is decided.
 *
 * Both catalogues share a `settle(market, selection, stats)` shape but not a
 * stats type, so the game's reader is bound here once and the loop below stays
 * unaware of which game it is settling.
 */
async function settlementFor(
  game: "carrom" | "ludo",
  matchId: string,
  match: MatchRecord,
  deps: SettlementDeps,
): Promise<(bet: BetWithMarket) => Settlement> {
  const marketOf = (bet: BetWithMarket) => ({
    marketType: bet.marketType,
    subject: bet.subject,
    line: bet.line,
  });

  if (game === "ludo") {
    const catalog = ludoCatalog();
    const stats =
      deps.ludoStats === undefined
        ? replayLudoLog(
            (await deps.matches.listEvents(matchId)).map((entry) => ({
              type: entry.type,
              payload: payloadOf(entry),
            })),
            { abandoned: match.result === null },
          ).stats
        : await deps.ludoStats(matchId, match);
    return (bet) => catalog.settle(marketOf(bet), bet.selectionKey, stats);
  }

  const catalog: CarromCatalog = deps.catalog ?? carromCatalog();
  const stats =
    deps.stats === undefined
      ? computeMatchStats(matchId, await deps.matches.listEvents(matchId))
      : await deps.stats(matchId, match);
  return (bet) => catalog.settle(marketOf(bet), bet.selectionKey, stats);
}

/** A stored log entry's payload, whichever field carries it. */
function payloadOf(entry: {
  readonly payload?: unknown;
  readonly data?: unknown;
}): Record<string, unknown> {
  const value = entry.payload ?? entry.data;
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** The bet status that goes with an outcome that needs no review. */
function outcomeToStatus(outcome: Settlement): "won" | "lost" | "void" {
  switch (outcome) {
    case "won":
      return "won";
    case "lost":
      return "lost";
    case "void":
    case "push":
      return "void";
  }
}

/**
 * The money for one decided bet.
 *
 * - won: escrow releases the stake to the player and the house pays the profit.
 * - lost: escrow releases the stake to the house.
 * - void or push: escrow returns the stake to the player.
 *
 * Every leg sums to zero, and the key is the bet id, so a re-run cannot pay
 * twice.
 */
async function moveMoney(
  book: Ledger,
  bet: BetWithMarket,
  outcome: Settlement,
  payoutMinor: number,
  at: string,
): Promise<void> {
  const userAccount = await book.userAccount(bet.userId);
  const escrowAccount = await book.escrowAccount();
  const houseAccount = await book.houseAccount();
  const key = `settle:${bet.id}`;
  const ref = { refType: "bet", refId: bet.id };

  void at;

  switch (outcome) {
    case "won": {
      const profit = payoutMinor - bet.stakeMinor;
      if (profit < 0) {
        throw new Error(`bet ${bet.id} pays less than its stake`);
      }
      await book.post({
        idempotencyKey: key,
        kind: "bet_payout",
        ...ref,
        entries: [
          { accountId: escrowAccount, amountMinor: -bet.stakeMinor },
          { accountId: userAccount, amountMinor: payoutMinor },
          { accountId: houseAccount, amountMinor: -profit },
        ].filter((entry) => entry.amountMinor !== 0),
      });
      return;
    }
    case "lost":
      await book.post({
        idempotencyKey: key,
        kind: "house_fee",
        ...ref,
        entries: [
          { accountId: escrowAccount, amountMinor: -bet.stakeMinor },
          { accountId: houseAccount, amountMinor: bet.stakeMinor },
        ],
      });
      return;
    case "void":
    case "push":
      await book.post({
        idempotencyKey: key,
        kind: "bet_refund",
        ...ref,
        entries: [
          { accountId: escrowAccount, amountMinor: -bet.stakeMinor },
          { accountId: userAccount, amountMinor: bet.stakeMinor },
        ],
      });
  }
}

/** Closes the match's markets: settled, or void when the match was void. */
async function closeMarkets(
  matchId: string,
  markets: MarketsRepository,
  voidReason: VoidReason,
  forfeit: boolean,
): Promise<number> {
  const rows = await markets.listForMatch(matchId);
  if (rows.length === 0) {
    return 0;
  }

  if (voidReason !== null) {
    await markets.setStatus(matchId, "void");
    return rows.length;
  }

  await markets.setStatus(matchId, "settled");

  if (forfeit) {
    const types = new Set(rows.map((row) => row.marketType));
    const voidTypes = [...types].filter((type) => !settlesOnForfeit(type));
    if (voidTypes.length > 0) {
      await markets.setStatusForTypes(matchId, voidTypes, "void");
    }
  }

  return rows.length;
}

/**
 * Subscribes settlement to the event the room publishes when a match is over.
 *
 * The handler never throws into the publisher: a settlement that fails is
 * logged and left for the next run, which is safe because settling is
 * idempotent.
 */
export function subscribeSettlement(deps: SettlementDeps): () => void {
  return subscribe("markets.ready_to_settle", async (payload) => {
    try {
      const report = await settleMatch(payload.matchId, deps);
      if (report.flagged) {
        logger.error({ matchId: payload.matchId, failure: report.failure }, "flagged match");
      }
    } catch (error) {
      logger.error({ matchId: payload.matchId, err: error }, "settlement failed");
    }
  });
}

export { FORFEIT_SETTLED_MARKETS };
