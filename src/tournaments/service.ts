import { z } from "zod";
import { commitOf, createMatchSeed } from "../lib/fair-rng.js";
import { publish } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import type { ExistingPlayer, MatchRecord, MatchRepository } from "../lib/match-repository.js";
import type { Ledger } from "../wallet/ledger.js";
import { formatFor } from "./format.js";
import type { MatchLauncher } from "./launcher.js";
import { computePrizes } from "./prizes.js";
import type {
  BracketPositionRecord,
  EntryRecord,
  PlayerRecord,
  TournamentRecord,
} from "./types.js";
import { tournamentConfigSchema } from "./types.js";
import type { NewPosition, PositionResult, TournamentRepository } from "./repository.js";
import { seedByRating } from "./seeding.js";

/**
 * The tournament lifecycle.
 *
 * One class holds every transition a tournament can make: draft to registration,
 * registration to running (with the bracket), a decided position to the next
 * round, and finally the payout. Everything it needs from storage, money and the
 * game itself arrives as an interface, so the whole lifecycle runs in tests with
 * no database, no wallet and no WebSocket.
 *
 * Two rules the code is built around:
 *
 * 1. Every write that could race goes through a conditional update
 *    (`claimPosition`, `completePosition`). A second scheduler, or a second tick,
 *    gets null back and does nothing. Everything else is idempotent by
 *    idempotency key: a refund or a payout posted twice returns the first
 *    transaction.
 * 2. Money is posted, never calculated into a balance. The rake, the split and
 *    the bot prize policy are decided once, by `computePrizes`, and posted as one
 *    balanced ledger transaction.
 */

/** What was wrong with the request. The API maps these onto status codes. */
export type TournamentErrorCode =
  | "not_found"
  | "wrong_status"
  | "registration_closed"
  | "registration_not_open"
  | "full"
  | "already_entered"
  | "not_entered"
  | "insufficient_funds"
  | "invalid"
  | "no_winner";

/** A refused transition, with a code the API can turn into a status. */
export class TournamentError extends Error {
  readonly code: TournamentErrorCode;

  constructor(code: TournamentErrorCode, message: string) {
    super(message);
    this.name = "TournamentError";
    this.code = code;
  }
}

/** The body of a tournament creation request. */
export const createTournamentSchema = z.strictObject({
  name: z.string().min(3).max(80),
  config: tournamentConfigSchema,
});

export type CreateTournamentRequest = z.infer<typeof createTournamentSchema>;

/** The dependencies the service needs, all injectable. */
export interface TournamentServiceDeps {
  readonly repository: TournamentRepository;
  readonly matches: MatchRepository;
  readonly ledger: Ledger;
  readonly launcher: MatchLauncher;
  /** The clock. Tests pin it; production uses the wall clock. */
  readonly now?: () => Date;
  /** The match seed factory. Never reached in the formatting tests. */
  readonly newSeed?: () => string;
}

/** The service. */
export class TournamentService {
  readonly #repository: TournamentRepository;
  readonly #matches: MatchRepository;
  readonly #ledger: Ledger;
  readonly #launcher: MatchLauncher;
  readonly #now: () => Date;
  readonly #newSeed: () => string;

  constructor(deps: TournamentServiceDeps) {
    this.#repository = deps.repository;
    this.#matches = deps.matches;
    this.#ledger = deps.ledger;
    this.#launcher = deps.launcher;
    this.#now = deps.now ?? (() => new Date());
    this.#newSeed = deps.newSeed ?? createMatchSeed;
  }

  // -------------------------------------------------------------------------
  // Creation and the lifecycle shell
  // -------------------------------------------------------------------------

  async create(request: CreateTournamentRequest): Promise<TournamentRecord> {
    const parsed = createTournamentSchema.safeParse(request);
    if (!parsed.success) {
      throw new TournamentError(
        "invalid",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }

    const { name, config } = parsed.data;
    const format = formatFor(config.format);

    if (config.minPlayers < format.minPlayers || config.maxPlayers > format.maxPlayers) {
      throw new TournamentError(
        "invalid",
        `${config.format} runs ${String(format.minPlayers)} to ${String(format.maxPlayers)} players`,
      );
    }

    return this.#repository.create({
      name,
      game: config.game,
      config,
      currency: this.#ledger.currency,
      status: "draft",
    });
  }

  /** Moves a draft tournament into registration and announces it. */
  async open(tournamentId: string): Promise<TournamentRecord> {
    const tournament = await this.#require(tournamentId);

    if (tournament.status !== "draft") {
      // Opening an open tournament is a no-op rather than an error: the
      // scheduler may retry, and that must be harmless.
      if (tournament.status === "registration") {
        return tournament;
      }
      throw new TournamentError(
        "wrong_status",
        `a ${tournament.status} tournament cannot be opened`,
      );
    }

    const updated = await this.#repository.update(tournamentId, { status: "registration" });

    await publish("tournament.opened", {
      tournamentId: updated.id,
      game: updated.game,
      opensAt: updated.registrationOpensAt ?? this.#now().toISOString(),
      closesAt: updated.registrationClosesAt ?? updated.startsAt ?? "",
      minPlayers: updated.minPlayers,
      maxPlayers: updated.maxPlayers,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Enters a player. The fee moves from their wallet to this tournament's prize
   * pool in one ledger transaction, keyed tournament plus player, so a double tap
   * on the button charges once.
   */
  async register(input: {
    readonly tournamentId: string;
    readonly profileId: string;
    readonly displayName: string;
  }): Promise<EntryRecord> {
    const tournament = await this.#require(input.tournamentId);
    const now = this.#now();

    if (tournament.status !== "registration") {
      throw new TournamentError(
        "wrong_status",
        `registration is not open: the tournament is ${tournament.status}`,
      );
    }

    if (
      tournament.registrationOpensAt !== null &&
      Date.parse(tournament.registrationOpensAt) > now.getTime()
    ) {
      throw new TournamentError("registration_not_open", "registration has not opened yet");
    }

    if (
      tournament.registrationClosesAt !== null &&
      Date.parse(tournament.registrationClosesAt) <= now.getTime()
    ) {
      throw new TournamentError("registration_closed", "registration has closed");
    }

    const entries = await this.#repository.listEntries(tournament.id);
    const live = entries.filter((entry) => entry.status !== "withdrawn");

    if (live.some((entry) => entry.playerId !== "" && entry.status !== "withdrawn")) {
      // keep the type useful below; the real check is the player match
    }

    if (live.length >= tournament.maxPlayers) {
      throw new TournamentError("full", "the tournament is full");
    }

    const player = await this.#repository.playerForProfile(input.profileId, input.displayName);
    if (live.some((entry) => entry.playerId === player.id)) {
      throw new TournamentError("already_entered", "you are already entered");
    }

    const fee = tournament.entryFeeMinor;

    if (fee > 0) {
      const wallet = await this.#ledger.userAccount(input.profileId);
      const balance = await this.#ledger.balanceOf(wallet);
      if (balance < fee) {
        throw new TournamentError(
          "insufficient_funds",
          `the entry fee is ${String(fee)} and the wallet holds ${String(balance)}`,
        );
      }

      const pool = await this.#ledger.prizePoolAccount(tournament.id);
      await this.#ledger.post({
        idempotencyKey: `${tournament.id}:${player.id}:entry`,
        kind: "tournament_entry",
        refType: "tournament",
        refId: tournament.id,
        entries: [
          { accountId: wallet, amountMinor: -fee },
          { accountId: pool, amountMinor: fee },
        ],
      });
    }

    const entry = await this.#repository.addEntry({
      tournamentId: tournament.id,
      playerId: player.id,
      entryFeeMinor: fee,
    });

    await this.#repository.update(tournament.id, {
      prizePoolMinor: tournament.prizePoolMinor + fee,
    });

    return entry;
  }

  /** Withdraws an entry before the deadline and refunds exactly what was paid. */
  async withdraw(input: {
    readonly tournamentId: string;
    readonly profileId: string;
  }): Promise<void> {
    const tournament = await this.#require(input.tournamentId);
    const now = this.#now();

    if (tournament.status !== "registration") {
      throw new TournamentError(
        "wrong_status",
        `withdrawal is closed: the tournament is ${tournament.status}`,
      );
    }

    if (
      tournament.registrationClosesAt !== null &&
      Date.parse(tournament.registrationClosesAt) <= now.getTime()
    ) {
      throw new TournamentError("registration_closed", "the withdrawal deadline has passed");
    }

    const player = await this.#repository.playerForProfile(input.profileId, input.profileId);
    const entry = await this.#repository.getEntry(tournament.id, player.id);

    if (entry === null || entry.status !== "registered") {
      throw new TournamentError("not_entered", "you are not entered in this tournament");
    }

    if (entry.entryFeeMinor > 0) {
      const wallet = await this.#ledger.userAccount(input.profileId);
      const pool = await this.#ledger.prizePoolAccount(tournament.id);
      await this.#ledger.post({
        idempotencyKey: `${tournament.id}:${entry.playerId}:refund`,
        kind: "adjustment",
        refType: "tournament_refund",
        refId: tournament.id,
        entries: [
          { accountId: pool, amountMinor: -entry.entryFeeMinor },
          { accountId: wallet, amountMinor: entry.entryFeeMinor },
        ],
      });
    }

    await this.#repository.updateEntry(tournament.id, entry.playerId, {
      status: "withdrawn",
      withdrawnAt: now.toISOString(),
    });

    await this.#repository.update(tournament.id, {
      prizePoolMinor: Math.max(0, tournament.prizePoolMinor - entry.entryFeeMinor),
    });
  }

  /**
   * Cancels and refunds every entry.
   *
   * Refunds are posted one transaction per player, each keyed on the tournament
   * and the player, so a cancelled tournament can be re-run to completion after a
   * crash without paying anyone twice. A player who withdrew was already
   * refunded and is skipped.
   */
  async cancel(
    tournamentId: string,
    reason: string,
  ): Promise<{ readonly refundedEntries: number; readonly refundedMinor: number }> {
    const tournament = await this.#require(tournamentId);

    if (tournament.status === "cancelled") {
      return { refundedEntries: 0, refundedMinor: 0 };
    }
    if (tournament.status === "finished") {
      throw new TournamentError("wrong_status", "a finished tournament cannot be cancelled");
    }

    const entries = await this.#repository.listEntries(tournamentId);
    const pool = await this.#ledger.prizePoolAccount(tournamentId);

    let refundedEntries = 0;
    let refundedMinor = 0;

    for (const entry of entries) {
      if (entry.status === "withdrawn" || entry.entryFeeMinor <= 0) {
        continue;
      }

      const player = await this.#repository.getPlayer(entry.playerId);
      if (player?.profileId === null || player === null) {
        logger.warn(
          { tournamentId, playerId: entry.playerId },
          "cannot refund an entry with no wallet",
        );
        continue;
      }

      const wallet = await this.#ledger.userAccount(player.profileId);
      await this.#ledger.post({
        idempotencyKey: `${tournamentId}:${entry.playerId}:cancel_refund`,
        kind: "adjustment",
        refType: "tournament_refund",
        refId: tournamentId,
        entries: [
          { accountId: pool, amountMinor: -entry.entryFeeMinor },
          { accountId: wallet, amountMinor: entry.entryFeeMinor },
        ],
      });

      await this.#repository.updateEntry(tournamentId, entry.playerId, { status: "withdrawn" });
      refundedEntries += 1;
      refundedMinor += entry.entryFeeMinor;
    }

    await this.#repository.update(tournamentId, {
      status: "cancelled",
      cancelledAt: this.#now().toISOString(),
      prizePoolMinor: tournament.prizePoolMinor - refundedMinor,
    });

    await publish("tournament.cancelled", {
      tournamentId,
      reason,
      refundedEntries,
      refundedMinor,
    });

    return { refundedEntries, refundedMinor };
  }

  // -------------------------------------------------------------------------
  // The bracket
  // -------------------------------------------------------------------------

  /**
   * Closes registration, seeds the entrants, fills the field with bots when the
   * config says so, and writes the whole schedule.
   *
   * A bye is not a match: a first-round position with one entrant is decided
   * immediately, so the published bracket already reads correctly.
   */
  async start(tournamentId: string): Promise<TournamentRecord> {
    let tournament = await this.#require(tournamentId);

    if (tournament.status === "running") {
      // A start that died half way leaves a running tournament with no bracket.
      // Finishing it here is safe: the bracket is written once.
      const positions = await this.#repository.listPositions(tournamentId);
      if (positions.length === 0) {
        await this.#generateBracket(tournament);
        tournament = (await this.#repository.get(tournamentId)) ?? tournament;
      }
      return tournament;
    }

    if (tournament.status !== "registration") {
      throw new TournamentError("wrong_status", `a ${tournament.status} tournament cannot start`);
    }

    // The claim: registration to running is one conditional write, so only one
    // server generates a bracket however many try at the same second.
    const claimed = await this.#repository.transition(tournamentId, "registration", "running");
    if (claimed === null) {
      const current = await this.#repository.get(tournamentId);
      if (current === null) {
        throw new TournamentError("not_found", `no tournament ${tournamentId}`);
      }
      const positions = await this.#repository.listPositions(tournamentId);
      if (current.status === "running" && positions.length === 0) {
        await this.#generateBracket(current);
      }
      return (await this.#repository.get(tournamentId)) ?? current;
    }

    await this.#generateBracket(claimed);
    return (await this.#repository.get(tournamentId)) ?? claimed;
  }

  /**
   * Seeds the entrants, fills a short field with bots, and writes the schedule.
   *
   * Called from `start`, and again from `settle` if a previous attempt died
   * between the status change and the bracket write. Every write it makes is
   * either idempotent by key or guarded by the bracket's unique constraint.
   */
  async #generateBracket(tournament: TournamentRecord): Promise<void> {
    const tournamentId = tournament.id;

    let entries = (await this.#repository.listEntries(tournamentId)).filter(
      (entry) => entry.status !== "withdrawn",
    );

    if (entries.length > tournament.maxPlayers) {
      // Only a race can get here: registration refuses a full tournament, so
      // this is two starters having filled the empty seats twice. Cancelling
      // would punish players who did nothing wrong, so the bracket keeps the
      // best rated, and the rest are marked out.
      logger.warn(
        { tournamentId, entries: entries.length, seats: tournament.maxPlayers },
        "more entries than seats; the bracket keeps the best rated",
      );
    }

    if (entries.length < tournament.minPlayers) {
      if (!tournament.config.fillWithBots) {
        await this.cancel(tournamentId, "not_enough_players");
        throw new TournamentError(
          "wrong_status",
          `${String(entries.length)} entries is below the minimum of ${String(tournament.minPlayers)}`,
        );
      }

      const needed = tournament.maxPlayers - entries.length;
      for (let index = 0; index < needed; index += 1) {
        const bot = await this.#repository.createBotPlayer(
          tournament.config.botLevel,
          `${botLabel(tournament.config.botLevel)} ${String(index + 1)}`,
        );
        await this.#repository.addEntry({
          tournamentId,
          playerId: bot.id,
          entryFeeMinor: 0,
        });
      }

      entries = (await this.#repository.listEntries(tournamentId)).filter(
        (entry) => entry.status !== "withdrawn",
      );
    }

    const format = formatFor(tournament.format);
    // Two starters racing can both fill the empty seats with bots before either
    // writes a bracket. The bracket is the tournament's size, so it wins.
    const seeded = seedByRating(entries).slice(0, tournament.maxPlayers);
    const plan = format.plan(seeded.length);
    const playerBySeed = new Map(seeded.map((entry) => [entry.seed, entry.playerId]));
    const seatedIds = new Set(seeded.map((entry) => entry.playerId));

    for (const entry of seeded) {
      await this.#repository.updateEntry(tournamentId, entry.playerId, {
        seed: entry.seed,
        status: "active",
      });
    }

    for (const entry of entries) {
      if (!seatedIds.has(entry.playerId)) {
        await this.#repository.updateEntry(tournamentId, entry.playerId, { status: "withdrawn" });
      }
    }

    const dueAt = tournament.startsAt ?? this.#now().toISOString();
    const positions: NewPosition[] = plan.positions.map((planned) => {
      const seat1 =
        planned.seat1Seed === null ? null : (playerBySeed.get(planned.seat1Seed) ?? null);
      const seat2 =
        planned.seat2Seed === null ? null : (playerBySeed.get(planned.seat2Seed) ?? null);
      const both = seat1 !== null && seat2 !== null;

      return {
        round: planned.round,
        slot: planned.slot,
        winnerToSlot: planned.winnerToSlot,
        seat1PlayerId: seat1,
        seat2PlayerId: seat2,
        status: both ? "ready" : "pending",
        dueAt: seat1 !== null || seat2 !== null ? dueAt : null,
      };
    });

    try {
      await this.#repository.insertPositions(tournamentId, positions);
    } catch (error) {
      // The insert is all or nothing and the bracket is unique, so this means a
      // bracket already exists: either another server drew it, or this one did
      // before a restart. Either way there is nothing left to write.
      const existing = await this.#repository.listPositions(tournamentId);
      if (existing.length > 0) {
        logger.info({ tournamentId }, "bracket already drawn");
        return;
      }
      throw error;
    }

    await publish("tournament.bracket_ready", {
      tournamentId,
      format: plan.format,
      entrants: plan.entrants,
      rounds: plan.rounds,
      byes: plan.byes,
      seeds: plan.seeds,
    });

    // Byes: one entrant in a first-round position advances without a match.
    const written = await this.#repository.listPositions(tournamentId);
    for (const position of written) {
      if (position.round !== 1 || position.winnerPlayerId !== null) {
        continue;
      }
      const seated = [position.seat1PlayerId, position.seat2PlayerId].filter(
        (playerId): playerId is string => playerId !== null,
      );
      if (seated.length === 1 && seated[0] !== undefined) {
        await this.#repository.completePosition(
          position.id,
          { winnerPlayerId: seated[0], loserPlayerId: null, isWalkover: false },
          this.#now().toISOString(),
        );
      }
    }

    await this.#advance(tournament);
  }

  /**
   * Starts every match whose time has come.
   *
   * The bracket position is claimed first, so two schedulers cannot both open a
   * room for the same match. If the room fails to open, the claim is released and
   * the next tick tries again.
   */
  async launchDue(tournamentId: string): Promise<number> {
    const tournament = await this.#require(tournamentId);
    if (tournament.status !== "running") {
      return 0;
    }

    const now = this.#now();
    const positions = await this.#repository.listPositions(tournamentId);
    const entries = await this.#seatedEntries(tournamentId);
    const entryByPlayer = new Map(entries.map((entry) => [entry.playerId, entry]));
    const turnSeconds = tournament.config.match.turnSeconds;

    let launched = 0;

    for (const position of positions) {
      if (position.winnerPlayerId !== null || position.matchId !== null) {
        continue;
      }
      if (position.seat1PlayerId === null || position.seat2PlayerId === null) {
        continue;
      }
      if (position.dueAt === null || Date.parse(position.dueAt) > now.getTime()) {
        continue;
      }
      if (tournament.game === "ludo") {
        // A Ludo room does not exist yet; the position waits rather than failing.
        continue;
      }

      const claimed = await this.#repository.claimPosition(position.id, now.toISOString());
      if (claimed === null) {
        continue;
      }

      const entry1 = entryByPlayer.get(position.seat1PlayerId);
      const entry2 = entryByPlayer.get(position.seat2PlayerId);
      const seat1 = entry1 === undefined ? null : await this.#repository.getPlayer(entry1.playerId);
      const seat2 = entry2 === undefined ? null : await this.#repository.getPlayer(entry2.playerId);

      if (seat1 === null || seat2 === null) {
        logger.warn({ tournamentId, positionId: position.id }, "a seat has no player");
        continue;
      }

      const seed = this.#newSeed();
      const seedCommit = commitOf(seed);

      try {
        const match = await this.#matches.create({
          seedCommit,
          scheduledAt: position.dueAt,
          config: {
            carrom: {
              pointsToWinMatch: tournament.config.match.targetPoints,
              boardsPerMatch: tournament.config.match.boardsPerMatch,
            },
            turnSeconds,
          },
          seats: [
            { seat: 1, existingPlayer: existingPlayerOf(seat1) },
            { seat: 2, existingPlayer: existingPlayerOf(seat2) },
          ],
        });

        await this.#repository.updatePosition(position.id, {
          matchId: match.id,
          status: "live",
          points: null,
        });

        await this.#launcher.launch({
          matchId: match.id,
          game: tournament.game,
          seed,
          seats: [
            {
              kind: seat1.isBot ? "bot" : "human",
              playerId: seat1.id,
              level: seat1.botLevel,
            },
            {
              kind: seat2.isBot ? "bot" : "human",
              playerId: seat2.id,
              level: seat2.botLevel,
            },
          ],
          turnSeconds,
          allowSpectators: tournament.config.allowSpectators,
        });

        await publish("match.created", {
          matchId: match.id,
          game: tournament.game,
          tournamentId,
          playerIds: [seat1.id, seat2.id],
          isBot: [seat1.isBot, seat2.isBot],
        });

        await publish("match.live", {
          matchId: match.id,
          game: tournament.game,
          tournamentId,
          startedAt: now.toISOString(),
        });

        launched += 1;
      } catch (error) {
        logger.error({ err: error, tournamentId, positionId: position.id }, "could not launch");
        await this.#repository.updatePosition(position.id, {
          status: "ready",
          launchedAt: null,
          matchId: null,
        });
      }
    }

    return launched;
  }

  /**
   * Brings the tournament up to date: results in, walkovers out, winners
   * advanced, and the payout if that was the final.
   *
   * Safe to call at any time, on any tournament, as often as you like. It reads
   * the world and does whatever is still outstanding.
   */
  async settle(tournamentId: string): Promise<void> {
    const tournament = await this.#require(tournamentId);
    if (tournament.status !== "running") {
      return;
    }

    if ((await this.#repository.listPositions(tournament.id)).length === 0) {
      // A start that died between the status change and the bracket write.
      await this.#generateBracket(tournament);
    }

    await this.#resolveResults(tournament);
    await this.#applyWalkovers(tournament);
    await this.#advance(tournament);
    await this.#maybeFinish(tournament);
  }

  /** An admin decision: this position goes to that player. */
  async forceAdvance(input: {
    readonly tournamentId: string;
    readonly positionId: string;
    readonly winnerPlayerId: string;
  }): Promise<void> {
    const tournament = await this.#require(input.tournamentId);
    const position = await this.#repository.getPosition(input.positionId);

    if (position === null || position.tournamentId !== tournament.id) {
      throw new TournamentError("not_found", "no such bracket position");
    }
    if (position.winnerPlayerId !== null) {
      throw new TournamentError("wrong_status", "that position is already decided");
    }
    if (
      position.seat1PlayerId !== input.winnerPlayerId &&
      position.seat2PlayerId !== input.winnerPlayerId
    ) {
      throw new TournamentError("invalid", "that player is not in that position");
    }

    const loser =
      position.seat1PlayerId === input.winnerPlayerId
        ? position.seat2PlayerId
        : position.seat1PlayerId;

    const decided: PositionResult = {
      winnerPlayerId: input.winnerPlayerId,
      loserPlayerId: loser,
      isWalkover: true,
    };

    const completed = await this.#repository.completePosition(
      position.id,
      decided,
      this.#now().toISOString(),
    );

    if (completed === null) {
      throw new TournamentError("wrong_status", "that position was decided already");
    }

    await this.#advance(tournament);
    await this.#maybeFinish(tournament);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #require(tournamentId: string): Promise<TournamentRecord> {
    const tournament = await this.#repository.get(tournamentId);
    if (tournament === null) {
      throw new TournamentError("not_found", `no tournament ${tournamentId}`);
    }
    return tournament;
  }

  async #seatedEntries(tournamentId: string): Promise<EntryRecord[]> {
    const entries = await this.#repository.listEntries(tournamentId);
    return entries.filter((entry) => entry.status !== "withdrawn");
  }

  /** Records every finished match's result onto its bracket position. */
  async #resolveResults(tournament: TournamentRecord): Promise<void> {
    const positions = await this.#repository.listPositions(tournament.id);
    const entries = await this.#seatedEntries(tournament.id);
    const seedOf = new Map(entries.map((entry) => [entry.playerId, entry.seed ?? 0]));

    for (const position of positions) {
      if (position.winnerPlayerId !== null || position.matchId === null) {
        continue;
      }

      const match = await this.#matches.get(position.matchId);
      if (match === null || match.status !== "finished" || match.result === null) {
        continue;
      }

      const decided = decideFromMatch(position, match, seedOf);
      if (decided === null) {
        continue;
      }

      const completed = await this.#repository.completePosition(
        position.id,
        decided,
        this.#now().toISOString(),
      );
      if (completed === null) {
        continue;
      }

      await publish("match.finished", {
        matchId: match.id,
        game: tournament.game,
        tournamentId: tournament.id,
        winnerPlayerId: completed.winnerPlayerId,
        loserPlayerId: completed.loserPlayerId,
        reason: match.result.reason,
        scores: match.result.scores,
      });
    }
  }

  /**
   * Applies the walkover rule: a human who has not turned up `walkoverSeconds`
   * after the match was due loses it.
   *
   * "Turned up" is read from the match row, which the room writes on the first
   * join. A bot never needs to turn up, and a seat whose match was never launched
   * has nobody in it at all, so it counts as absent.
   */
  async #applyWalkovers(tournament: TournamentRecord): Promise<void> {
    const windowMs = tournament.config.walkoverSeconds * 1000;
    const now = this.#now();
    const positions = await this.#repository.listPositions(tournament.id);
    const entries = await this.#seatedEntries(tournament.id);
    const entryByPlayer = new Map(entries.map((entry) => [entry.playerId, entry]));

    for (const position of positions) {
      if (position.winnerPlayerId !== null) {
        continue;
      }
      if (position.seat1PlayerId === null || position.seat2PlayerId === null) {
        continue;
      }

      const due = position.dueAt ?? position.launchedAt;
      if (due === null || now.getTime() - Date.parse(due) < windowMs) {
        continue;
      }

      const match = position.matchId === null ? null : await this.#matches.get(position.matchId);
      if (match !== null && match.status === "finished") {
        continue;
      }

      const seat1 = entryByPlayer.get(position.seat1PlayerId);
      const seat2 = entryByPlayer.get(position.seat2PlayerId);
      if (seat1 === undefined || seat2 === undefined) {
        continue;
      }

      const absent1 = isAbsent(seat1, 1, match);
      const absent2 = isAbsent(seat2, 2, match);

      if (absent1 !== absent2) {
        // Exactly one of them failed to turn up: the other advances.
      } else if (!absent1) {
        // Both turned up and the match is still running: nothing to decide.
        continue;
      }
      // Both absent. A tournament cannot stall on two no-shows, so the better
      // placed seat advances, which is the same seat the bracket gave the better
      // seed. It is marked a walkover either way, so nobody mistakes it for play.

      const winner = absent1 ? seat2.playerId : seat1.playerId;
      const loser = absent1 ? seat1.playerId : seat2.playerId;

      const completed = await this.#repository.completePosition(
        position.id,
        { winnerPlayerId: winner, loserPlayerId: loser, isWalkover: true },
        now.toISOString(),
      );
      if (completed === null) {
        continue;
      }

      logger.info({ tournamentId: tournament.id, positionId: position.id, loser }, "walkover");

      await publish("match.finished", {
        matchId: position.matchId ?? position.id,
        game: tournament.game,
        tournamentId: tournament.id,
        winnerPlayerId: winner,
        loserPlayerId: loser,
        reason: "walkover",
        scores: { white: 0, black: 0 },
      });
    }
  }

  /** Fills the next round's seat for every decided position. */
  async #advance(tournament: TournamentRecord): Promise<void> {
    const entries = await this.#seatedEntries(tournament.id);
    if (entries.length === 0) {
      return;
    }

    const format = formatFor(tournament.format);
    const positions = await this.#repository.listPositions(tournament.id);
    const entrants = bracketEntrants(positions);
    if (positions.length === 0 || entrants < 2) {
      return;
    }
    const plan = format.plan(entrants);

    const bySlot = new Map(positions.map((position) => [keyOf(position), position]));
    const changedRounds = new Set<number>();

    for (const position of positions) {
      const winner = position.winnerPlayerId;
      if (winner === null) {
        continue;
      }

      if (position.loserPlayerId !== null) {
        await this.#repository.updateEntry(tournament.id, position.loserPlayerId, {
          status: "eliminated",
          eliminatedRound: position.round,
        });
      }

      const planned = plan.positions.find(
        (candidate) => candidate.round === position.round && candidate.slot === position.slot,
      );
      if (planned === undefined) {
        continue;
      }

      const next = format.nextSeat(planned);
      if (next === null) {
        continue;
      }

      const target = bySlot.get(`${String(next.round)}:${String(next.slot)}`);
      if (target === undefined) {
        continue;
      }

      const filled = next.seat === 1 ? target.seat1PlayerId : target.seat2PlayerId;
      if (filled === winner) {
        continue;
      }

      let updated = await this.#repository.updatePosition(
        target.id,
        next.seat === 1 ? { seat1PlayerId: winner } : { seat2PlayerId: winner },
      );

      bySlot.set(keyOf(updated), updated);

      if (
        updated.seat1PlayerId !== null &&
        updated.seat2PlayerId !== null &&
        updated.status === "pending"
      ) {
        updated = await this.#repository.updatePosition(target.id, {
          status: "ready",
          dueAt: updated.dueAt ?? this.#now().toISOString(),
        });
        bySlot.set(keyOf(updated), updated);
        changedRounds.add(updated.round);
      }
    }

    // A round is announced once, when every position in it is drawn.
    for (const round of changedRounds) {
      const inRound = [...bySlot.values()].filter((position) => position.round === round);
      const drawn = inRound.every(
        (position) => position.seat1PlayerId !== null && position.seat2PlayerId !== null,
      );
      if (!drawn) {
        continue;
      }

      await publish("tournament.round_started", {
        tournamentId: tournament.id,
        round,
        matches: inRound
          .sort((left, right) => left.slot - right.slot)
          .map((position) => ({
            bracketMatchId: position.id,
            slot: position.slot,
            playerIds: [position.seat1PlayerId, position.seat2PlayerId],
          })),
      });
    }
  }

  /** Pays the prizes the moment the format says the tournament is decided. */
  async #maybeFinish(tournament: TournamentRecord): Promise<void> {
    const entries = await this.#seatedEntries(tournament.id);
    if (entries.length === 0) {
      return;
    }

    const format = formatFor(tournament.format);
    const positions = await this.#repository.listPositions(tournament.id);
    const entrants = bracketEntrants(positions);
    if (positions.length === 0 || entrants < 2) {
      return;
    }
    const plan = format.plan(entrants);

    const outcome = format.summarise(
      plan,
      positions.map((position) => ({
        round: position.round,
        slot: position.slot,
        seat1PlayerId: position.seat1PlayerId,
        seat2PlayerId: position.seat2PlayerId,
        winnerPlayerId: position.winnerPlayerId,
        loserPlayerId: position.loserPlayerId,
        points: position.points,
      })),
      entries.map((entry) => ({
        playerId: entry.playerId,
        seed: entry.seed ?? 0,
        isBot: entry.isBot,
      })),
    );

    if (!outcome.done || outcome.championPlayerId === null) {
      return;
    }

    const players = new Map(entries.map((entry) => [entry.playerId, { isBot: entry.isBot }]));
    const prizes = computePrizes({
      poolMinor: tournament.prizePoolMinor,
      rakeBps: tournament.config.rakeBps,
      prizeSplit: tournament.config.prizeSplit,
      order: outcome.places,
      players,
      botPrizePolicy: tournament.config.botPrizePolicy,
    });

    if (tournament.prizePoolMinor > 0) {
      const pool = await this.#ledger.prizePoolAccount(tournament.id);
      const house = await this.#ledger.houseAccount();

      // Player ids to wallet accounts. A prize whose winner has no wallet (a
      // human with no profile, which cannot happen through registration) stays
      // with the house rather than vanishing.
      const legs = new Map<string, number>();
      addLeg(legs, pool, -tournament.prizePoolMinor);
      let unclaimedMinor = prizes.houseMinor;

      for (const payout of prizes.payouts) {
        const player = await this.#repository.getPlayer(payout.playerId);
        if (player === null || player.profileId === null) {
          unclaimedMinor += payout.amountMinor;
          continue;
        }
        const wallet = await this.#ledger.userAccount(player.profileId);
        addLeg(legs, wallet, payout.amountMinor);
      }

      if (unclaimedMinor > 0) {
        addLeg(legs, house, unclaimedMinor);
      }

      await this.#ledger.post({
        idempotencyKey: `${tournament.id}:payouts`,
        kind: "tournament_prize",
        refType: "tournament",
        refId: tournament.id,
        entries: [...legs.entries()].map(([accountId, amountMinor]) => ({
          accountId,
          amountMinor,
        })),
      });
    }

    await this.#repository.updateEntry(tournament.id, outcome.championPlayerId, {
      status: "winner",
    });

    const payouts = prizes.payouts.map((payout) => ({
      playerId: payout.playerId,
      place: payout.place,
      amountMinor: payout.amountMinor,
      viaBotPlayerId: payout.viaBotPlayerId,
    }));

    await this.#repository.update(tournament.id, {
      status: "finished",
      championPlayerId: outcome.championPlayerId,
      payouts,
      finishedAt: this.#now().toISOString(),
    });

    await publish("tournament.finished", {
      tournamentId: tournament.id,
      championPlayerId: outcome.championPlayerId,
      prizePoolMinor: tournament.prizePoolMinor,
      rakeMinor: prizes.rakeMinor,
      payouts,
    });
  }
}

/**
 * How many players the bracket holds, read from the bracket itself.
 *
 * The entry list can be longer than the bracket (a race can leave unused bot
 * entries behind), and the format must be told the bracket's size, not the
 * entry count, or it looks for rounds that were never drawn.
 */
function bracketEntrants(positions: readonly BracketPositionRecord[]): number {
  return positions
    .filter((position) => position.round === 1)
    .flatMap((position) => [position.seat1PlayerId, position.seat2PlayerId])
    .filter((playerId): playerId is string => playerId !== null).length;
}

/** The key a bracket position is looked up by. */
function keyOf(position: BracketPositionRecord): string {
  return `${String(position.round)}:${String(position.slot)}`;
}

/** Accumulates legs, so two prizes to the same account become one entry. */
function addLeg(legs: Map<string, number>, accountId: string, amountMinor: number): void {
  legs.set(accountId, (legs.get(accountId) ?? 0) + amountMinor);
}

function botLabel(level: string): string {
  return level === "master" ? "Master bot" : level === "club" ? "Club bot" : "Rookie bot";
}

function existingPlayerOf(player: PlayerRecord): ExistingPlayer {
  return {
    id: player.id,
    displayName: player.displayName,
    isBot: player.isBot,
    botPolicy: player.botPolicy,
    botLevel: player.botLevel,
    profileId: player.profileId,
    skill: { rating: player.rating },
  };
}

/** True when this seat is a human who never connected. */
function isAbsent(entry: EntryRecord, seat: 1 | 2, match: MatchRecord | null): boolean {
  if (entry.isBot) {
    return false;
  }
  if (match === null) {
    return true;
  }
  return (seat === 1 ? match.seat1JoinedAt : match.seat2JoinedAt) === null;
}

/**
 * The bracket decision for a finished match.
 *
 * A drawn match (a tie on the board limit) is decided by seed: the better seed
 * advances. That is deterministic, it is the same rule the bracket already uses
 * for byes, and it never lets a level score hold up a tournament.
 */
function decideFromMatch(
  position: BracketPositionRecord,
  match: MatchRecord,
  seedOf: ReadonlyMap<string, number>,
): PositionResult | null {
  const result = match.result;
  if (result === null) {
    return null;
  }

  const points = { seat1: result.scores.white, seat2: result.scores.black };

  if (result.winnerSeat === 1 && position.seat1PlayerId !== null) {
    return {
      winnerPlayerId: position.seat1PlayerId,
      loserPlayerId: position.seat2PlayerId,
      isWalkover: false,
      points,
    };
  }
  if (result.winnerSeat === 2 && position.seat2PlayerId !== null) {
    return {
      winnerPlayerId: position.seat2PlayerId,
      loserPlayerId: position.seat1PlayerId,
      isWalkover: false,
      points,
    };
  }

  // A draw: the better seed advances.
  if (position.seat1PlayerId === null || position.seat2PlayerId === null) {
    return null;
  }
  const seed1 = seedOf.get(position.seat1PlayerId) ?? Number.MAX_SAFE_INTEGER;
  const seed2 = seedOf.get(position.seat2PlayerId) ?? Number.MAX_SAFE_INTEGER;
  const winner = seed1 <= seed2 ? position.seat1PlayerId : position.seat2PlayerId;
  const loser = winner === position.seat1PlayerId ? position.seat2PlayerId : position.seat1PlayerId;

  return { winnerPlayerId: winner, loserPlayerId: loser, isWalkover: false, points };
}
