import { z } from "zod";
import { BOT_LEVELS, type BotLevel } from "../engines/carrom/bot-config.js";

/**
 * The tournament domain: what a tournament is, what an entry is, and where a
 * bracket position sits.
 *
 * Nothing in this file knows Carrom from Ludo. The game is a field, and the only
 * code that touches a specific game is the launcher, which is why Ludo can be
 * added without touching a single line here.
 */

/** The formats this build can run. Swiss arrives by adding one entry here. */
export const TOURNAMENT_FORMATS = ["single_elimination", "round_robin"] as const;

export type TournamentFormatKind = (typeof TOURNAMENT_FORMATS)[number];

/** The lifecycle, mirroring the check constraint on tournaments.status. */
export const TOURNAMENT_STATUSES = [
  "draft",
  "registration",
  "running",
  "finished",
  "cancelled",
] as const;

export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];

/** What happens to a prize a bot wins. */
export const BOT_PRIZE_POLICIES = ["next_human", "house_keeps"] as const;

export type BotPrizePolicy = (typeof BOT_PRIZE_POLICIES)[number];

/** Entry states, mirroring the check constraint on tournament_entries.status. */
export const ENTRY_STATUSES = [
  "registered",
  "active",
  "eliminated",
  "winner",
  "withdrawn",
] as const;

export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** Bracket position states, mirroring tournament_matches.status. */
export const POSITION_STATUSES = [
  "pending",
  "ready",
  "live",
  "finished",
  "walkover",
  "void",
] as const;

export type PositionStatus = (typeof POSITION_STATUSES)[number];

/** The games this server can run. */
export const TOURNAMENT_GAMES = ["carrom", "ludo"] as const;

export type TournamentGame = (typeof TOURNAMENT_GAMES)[number];

const isoDateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be an ISO 8601 date-time",
});

/**
 * How a single match in the tournament is decided. Both limits apply: the first
 * to `targetPoints` wins, and a match that reaches `boardsPerMatch` boards ends
 * on the score.
 */
export const matchConfigSchema = z.strictObject({
  targetPoints: z.number().int().min(5).max(200).default(25),
  boardsPerMatch: z.number().int().min(1).max(9).default(1),
  /** Turn clock per shot, seconds, handed to the room. */
  turnSeconds: z.number().int().min(5).max(300).default(30),
});

export type MatchConfig = z.infer<typeof matchConfigSchema>;

/**
 * Everything an admin chooses when creating a tournament.
 *
 * Percentages are integers and are renormalised to the number of players who
 * actually finish in the money: the default 60/30/10 pays 60:30 of the pool
 * between two players (1200:600 of 1800), with nothing stranded.
 */
export const tournamentConfigSchema = z
  .strictObject({
    game: z.enum(TOURNAMENT_GAMES).default("carrom"),
    format: z.enum(TOURNAMENT_FORMATS).default("single_elimination"),
    minPlayers: z.number().int().min(2).max(64),
    maxPlayers: z.number().int().min(2).max(64),
    entryFeeMinor: z.number().int().min(0).max(100_000_000).default(0),
    /** House rake in basis points of the final pool: 1000 = 10%. */
    rakeBps: z.number().int().min(0).max(5000).default(1000),
    /** Prize shares by place, best first, as whole percentages. */
    prizeSplit: z.array(z.number().int().min(0).max(100)).min(1).max(5).default([60, 30, 10]),
    botPrizePolicy: z.enum(BOT_PRIZE_POLICIES).default("next_human"),
    /**
     * Off by default. When on, a tournament that is short of its minimum at the
     * deadline fills the empty seats with labelled bots rather than cancelling.
     */
    fillWithBots: z.boolean().default(false),
    botLevel: z.enum(BOT_LEVELS).default("club"),
    registrationOpensAt: isoDateTime.optional(),
    registrationClosesAt: isoDateTime.optional(),
    startsAt: isoDateTime.optional(),
    /** How long a human has to turn up before a walkover, from the match due time. */
    walkoverSeconds: z.number().int().min(30).max(3600).default(180),
    match: matchConfigSchema.default({ targetPoints: 25, boardsPerMatch: 1, turnSeconds: 30 }),
    allowSpectators: z.boolean().default(true),
  })
  .refine((value) => value.maxPlayers >= value.minPlayers, {
    message: "maxPlayers must not be smaller than minPlayers",
    path: ["maxPlayers"],
  })
  .refine(
    (value) =>
      value.registrationClosesAt === undefined ||
      value.registrationOpensAt === undefined ||
      Date.parse(value.registrationClosesAt) > Date.parse(value.registrationOpensAt),
    { message: "registration must close after it opens", path: ["registrationClosesAt"] },
  )
  .refine(
    (value) =>
      value.startsAt === undefined ||
      value.registrationClosesAt === undefined ||
      Date.parse(value.startsAt) >= Date.parse(value.registrationClosesAt),
    {
      message: "the tournament cannot start before registration closes",
      path: ["startsAt"],
    },
  )
  .refine((value) => value.format !== "single_elimination" || value.maxPlayers <= 64, {
    message: "single elimination runs at most 64 players",
    path: ["maxPlayers"],
  })
  .refine((value) => value.format !== "round_robin" || value.maxPlayers <= 8, {
    message: "round robin runs at most 8 players",
    path: ["maxPlayers"],
  });

export type TournamentConfig = z.infer<typeof tournamentConfigSchema>;

/** A tournament as stored. */
export interface TournamentRecord {
  readonly id: string;
  readonly game: TournamentGame;
  readonly name: string;
  readonly format: TournamentFormatKind;
  readonly status: TournamentStatus;
  readonly entryFeeMinor: number;
  readonly prizePoolMinor: number;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly currency: string;
  readonly config: TournamentConfig;
  readonly registrationOpensAt: string | null;
  readonly registrationClosesAt: string | null;
  readonly startsAt: string | null;
  readonly championPlayerId: string | null;
  readonly payouts: readonly TournamentPayoutRecord[] | null;
  readonly finishedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
}

/** One prize actually paid, as recorded on the tournament. */
export interface TournamentPayoutRecord {
  readonly playerId: string;
  readonly place: number;
  readonly amountMinor: number;
  /** The bot whose prize this was, when it was passed on. */
  readonly viaBotPlayerId: string | null;
}

/** A player, human or bot, as the tournament needs to see them. */
export interface PlayerRecord {
  readonly id: string;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly botLevel: BotLevel | null;
  readonly botPolicy: string | null;
  readonly profileId: string | null;
  /** Measured strength, used for seeding. Higher is stronger. */
  readonly rating: number;
}

/** One entry in a tournament. */
export interface EntryRecord {
  readonly tournamentId: string;
  readonly playerId: string;
  readonly seed: number | null;
  readonly status: EntryStatus;
  readonly entryFeeMinor: number;
  readonly registeredAt: string | null;
  readonly withdrawnAt: string | null;
  readonly eliminatedRound: number | null;
  readonly isBot: boolean;
  readonly displayName: string;
  readonly rating: number;
}

/** The two seats of a bracket position. */
export type PositionSeat = 1 | 2;

/** One bracket position: a match, or a slot that will hold one. */
export interface BracketPositionRecord {
  readonly id: string;
  readonly tournamentId: string;
  readonly round: number;
  readonly slot: number;
  /** The round-1+ slot the winner moves to. Null in a final. */
  readonly winnerToSlot: number | null;
  readonly seat1PlayerId: string | null;
  readonly seat2PlayerId: string | null;
  readonly status: PositionStatus;
  readonly dueAt: string | null;
  readonly launchedAt: string | null;
  readonly completedAt: string | null;
  readonly winnerPlayerId: string | null;
  readonly loserPlayerId: string | null;
  readonly matchId: string | null;
  readonly isWalkover: boolean;
  readonly points: { readonly seat1: number; readonly seat2: number } | null;
}

/** A position with the seed that occupies each seat, as planned. */
export interface PlannedPosition {
  readonly round: number;
  readonly slot: number;
  readonly seat1Seed: number | null;
  readonly seat2Seed: number | null;
  readonly winnerToSlot: number | null;
}

/** Where an entrant starts, and how many rounds there are. */
export interface FormatPlan {
  readonly format: TournamentFormatKind;
  readonly entrants: number;
  readonly rounds: number;
  readonly byes: number;
  /** Seeds in bracket order, seat by seat, with null for an empty seat. */
  readonly seeds: readonly (number | null)[];
  /** Every position in the whole schedule. */
  readonly positions: readonly PlannedPosition[];
}

/** A position with its result, as the format reads it. */
export interface DecidedPosition {
  readonly round: number;
  readonly slot: number;
  /** Who sat in each seat. Null while a seat is still unfilled. */
  readonly seat1PlayerId: string | null;
  readonly seat2PlayerId: string | null;
  readonly winnerPlayerId: string | null;
  readonly loserPlayerId: string | null;
  readonly points: { readonly seat1: number; readonly seat2: number } | null;
}

/** Where a player finished. */
export interface FinishPlace {
  readonly playerId: string;
  readonly place: number;
  /** The round they went out in. Null for the winner. */
  readonly eliminatedRound: number | null;
}

/** The read on a tournament's progress. */
export interface FormatOutcome {
  readonly done: boolean;
  readonly championPlayerId: string | null;
  /** Every entrant, best place first. Empty while the tournament is running, unless `done`. */
  readonly places: readonly FinishPlace[];
  /** Per-player progress to write back onto the entry rows. */
  readonly eliminated: readonly { readonly playerId: string; readonly round: number }[];
}

/** What the format needs to know about an entrant. */
export interface FormatEntrant {
  readonly playerId: string;
  readonly seed: number;
  readonly isBot: boolean;
}
