import { z } from "zod";

/**
 * The contract between the server and the website.
 *
 * This file is copied into the website repository as it is, so it imports nothing
 * from the server: no Express, no Supabase, no Node built-ins, only zod. Anything
 * the browser needs in order to read a stream or a response lives here, including
 * the frame decoder.
 *
 * Conventions that hold everywhere below:
 * - money is an integer in minor units (kobo for NGN), never a float;
 * - timestamps are ISO 8601 strings in UTC;
 * - a closed set of values is a zod enum, so a typo fails to compile;
 * - `ok: false` always carries an `error` code, never a human sentence.
 */

export const CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Integer minor units. The server rejects a fractional amount, so should you. */
export const moneySchema = z.number().int();
export type Money = z.infer<typeof moneySchema>;

/** An ISO 8601 timestamp in UTC. */
export const timestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof timestampSchema>;

export const moneyModeSchema = z.enum(["virtual", "real"]);
export type MoneyMode = z.infer<typeof moneyModeSchema>;

export const matchStatusSchema = z.enum(["scheduled", "live", "finished", "void", "abandoned"]);
export type MatchStatus = z.infer<typeof matchStatusSchema>;

export const botLevelSchema = z.enum(["rookie", "club", "master"]);
export type BotLevel = z.infer<typeof botLevelSchema>;

/** The error envelope every route uses when `ok` is false. */
export const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  /** Present when the failure names a limit that was hit. */
  limit: z.string().nullish(),
  /** Present on a validation failure: which field, and why. */
  issues: z.array(z.object({ path: z.string(), message: z.string() })).nullish(),
});
export type ApiError = z.infer<typeof errorSchema>;

/** Success is `{ ok: true }` plus the route's own fields, never wrapped twice. */
export const successSchema = z.object({ ok: z.literal(true) });
export type Success = z.infer<typeof successSchema>;

// ---------------------------------------------------------------------------
// Spectator frames
//
// A frame is every body's position at one instant, 30 times a second. Sending
// floats would be about 16 bytes per body per frame; quantising to unsigned
// 16-bit integers over the board's own coordinate space brings that to 4 bytes,
// and base64 keeps it URL-safe and JSON-safe.
//
// The mapping, in both directions:
//
//     value   = round(clamp(x, 0, BOARD_SPAN_MM) / BOARD_SPAN_MM * 65534)
//     x       = value / 65534 * BOARD_SPAN_MM
//
// The value 65535 is reserved: it means "this body is not on the board in this
// frame", which is how a pocketed coin or a striker that has not been placed yet
// is described. `frameBodies` leaves such a body out, and `positionAt` returns
// null for it.
//
// Positions are therefore millimetres, rounded to 740 / 65535 = 0.0113 mm, which
// is far finer than a coin's radius (15.5 mm). The byte order of each 16-bit
// value is the platform's: encode and decode both happen here, and the bytes
// travel inside one message, so both sides always agree.
// ---------------------------------------------------------------------------

/** The board's coordinate span in millimetres: 0 is one wall, this is the other. */
export const BOARD_SPAN_MM = 740;

/**
 * The largest quantised coordinate. One value below the 16-bit ceiling is left
 * free as {@link FRAME_ABSENT}, so a body that is not on the board in a given
 * frame (a coin that has just been pocketed, the striker before it is placed)
 * can say so instead of being drawn at the origin.
 */
export const FRAME_SCALE = 65534;

/** The sentinel for "this body is not on the board in this frame". */
export const FRAME_ABSENT = 65535;

/** One frame's bodies, in the order `bodyIds` lists them. */
export const encodedFramesSchema = z.object({
  /** Frames per second. The server records at 30. */
  fps: z.number().int().positive().max(120),
  /** Body ids, in the order their positions appear in `data`. */
  bodyIds: z.array(z.string()).max(64),
  /** How many frames the shot produced. */
  frameCount: z.number().int().nonnegative(),
  /** `frameCount * bodyIds.length * 2` unsigned 16-bit values, base64. */
  data: z.string(),
});
export type EncodedFrames = z.infer<typeof encodedFramesSchema>;

/** Frames as the engine produces them, before encoding. */
export interface RawFrame {
  readonly t: number;
  readonly bodies: readonly { readonly id: string; readonly x: number; readonly y: number }[];
}

export interface RawFrames {
  readonly fps: number;
  readonly frames: readonly RawFrame[];
}

/** Frames after decoding, still quantised: read a position with `positionAt`. */
export interface DecodedFrames {
  readonly fps: number;
  readonly bodyIds: readonly string[];
  readonly frameCount: number;
  /** Dequantised millimetres, `[x0, y0, x1, y1, ...]` per frame. */
  readonly values: Float64Array;
}

/** The 64-character alphabet base64 uses, without relying on any global. */
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_INDEX: ReadonlyMap<string, number> = new Map(
  [...BASE64].map((character, index) => [character, index]),
);

/** Encodes bytes as base64. Byte-order-agnostic: it never interprets them. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  let index = 0;

  while (index + 2 < bytes.length) {
    const triple =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out += BASE64[(triple >> 18) & 63];
    out += BASE64[(triple >> 12) & 63];
    out += BASE64[(triple >> 6) & 63];
    out += BASE64[triple & 63];
    index += 3;
  }

  const rest = bytes.length - index;
  if (rest === 1) {
    const triple = (bytes[index] ?? 0) << 16;
    out += BASE64[(triple >> 18) & 63];
    out += BASE64[(triple >> 12) & 63];
    out += "==";
  } else if (rest === 2) {
    const triple = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    out += BASE64[(triple >> 18) & 63];
    out += BASE64[(triple >> 12) & 63];
    out += BASE64[(triple >> 6) & 63];
    out += "=";
  }

  return out;
}

/** Decodes base64 to bytes. Throws on a character outside the alphabet. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/u, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;

  for (const character of clean) {
    const value = BASE64_INDEX.get(character);
    if (value === undefined) {
      throw new Error(`not base64: ${character}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }

  return bytes.subarray(0, written);
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/** True when a quantised value means the body is absent, not at the origin. */
export function isAbsent(value: number): boolean {
  return value === FRAME_ABSENT;
}

/** Quantises one millimetre coordinate to its 16-bit value. */
export function quantise(millimetres: number): number {
  return Math.round(clampUnit(millimetres / BOARD_SPAN_MM) * FRAME_SCALE);
}

/** Turns one 16-bit value back into millimetres. */
export function dequantise(value: number): number {
  return (value / FRAME_SCALE) * BOARD_SPAN_MM;
}

/**
 * Encodes a shot's frames for the wire.
 *
 * Every frame in a shot must list the same bodies in the same order; the ids of
 * the first frame become the header and a later frame that disagrees is skipped
 * rather than trusted, so a malformed recording cannot corrupt the decoder.
 */
export function encodeFrames(raw: RawFrames): EncodedFrames {
  const first = raw.frames[0];
  const bodyIds = first === undefined ? [] : first.bodies.map((body) => body.id);
  const perFrame = bodyIds.length * 2;
  const values = new Uint16Array(raw.frames.length * perFrame);

  raw.frames.forEach((frame, frameIndex) => {
    const offset = frameIndex * perFrame;
    bodyIds.forEach((id, bodyIndex) => {
      const body = frame.bodies.find((candidate) => candidate.id === id);
      if (body === undefined) {
        // Off the board in this frame: say so rather than write the origin.
        values[offset + bodyIndex * 2] = FRAME_ABSENT;
        values[offset + bodyIndex * 2 + 1] = FRAME_ABSENT;
        return;
      }
      values[offset + bodyIndex * 2] = quantise(body.x);
      values[offset + bodyIndex * 2 + 1] = quantise(body.y);
    });
  });

  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);

  return {
    fps: raw.fps,
    bodyIds,
    frameCount: raw.frames.length,
    data: encodeBase64(bytes),
  };
}

/** Decodes what `encodeFrames` wrote. The mirror image, in the same file. */
export function decodeFrames(encoded: EncodedFrames): DecodedFrames {
  const perFrame = encoded.bodyIds.length * 2;
  const expected = encoded.frameCount * perFrame;
  const bytes = decodeBase64(encoded.data);
  const values = new Float64Array(expected);

  const read = (index: number): number => {
    const low = bytes[index * 2] ?? 0;
    const high = bytes[index * 2 + 1] ?? 0;
    const value = low | (high << 8);
    // Kept as the sentinel: the reader decides what an absent body means.
    return value === FRAME_ABSENT ? Number.NaN : dequantise(value);
  };

  for (let index = 0; index < expected; index += 1) {
    values[index] = read(index);
  }

  return {
    fps: encoded.fps,
    bodyIds: encoded.bodyIds,
    frameCount: encoded.frameCount,
    values,
  };
}

/** One body's position in one frame, in millimetres, or null when absent. */
export function positionAt(
  decoded: DecodedFrames,
  frameIndex: number,
  bodyId: string,
): { readonly x: number; readonly y: number } | null {
  if (frameIndex < 0 || frameIndex >= decoded.frameCount) {
    return null;
  }
  const bodyIndex = decoded.bodyIds.indexOf(bodyId);
  if (bodyIndex === -1) {
    return null;
  }
  const offset = frameIndex * decoded.bodyIds.length * 2 + bodyIndex * 2;
  const x = decoded.values[offset];
  const y = decoded.values[offset + 1];
  if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) {
    return null;
  }
  return { x, y };
}

/** Every body's position in one frame, in the header's order. */
export function frameBodies(
  decoded: DecodedFrames,
  frameIndex: number,
): readonly { readonly id: string; readonly x: number; readonly y: number }[] {
  if (frameIndex < 0 || frameIndex >= decoded.frameCount) {
    return [];
  }
  const present: { id: string; x: number; y: number }[] = [];
  decoded.bodyIds.forEach((id, bodyIndex) => {
    const offset = frameIndex * decoded.bodyIds.length * 2 + bodyIndex * 2;
    const x = decoded.values[offset];
    const y = decoded.values[offset + 1];
    // A body that is not on the board in this frame is simply not listed.
    if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) {
      return;
    }
    present.push({ id, x, y });
  });
  return present;
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/** A body on the board, in the snapshot and in `nextState`. */
export const bodySchema = z.object({
  id: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Body = z.infer<typeof bodySchema>;

export const coinSchema = bodySchema.extend({
  colour: z.enum(["white", "black", "queen"]),
});
export type Coin = z.infer<typeof coinSchema>;

export const seatSchema = z.object({
  seat: z.union([z.literal(1), z.literal(2)]),
  playerId: z.string().nullable(),
  displayName: z.string(),
  isBot: z.boolean(),
  botLevel: botLevelSchema.nullable(),
  score: z.number().int(),
  connected: z.boolean(),
});
export type Seat = z.infer<typeof seatSchema>;

/** What happened during a shot. Free-form by design: the engine owns the detail. */
export const shotEventSchema = z.looseObject({
  type: z.string(),
  shot: z.number().int(),
});
export type ShotEvent = z.infer<typeof shotEventSchema>;

/** The state the board is in after a shot. */
export const nextStateSchema = z.object({
  board: z.number().int(),
  turn: z.enum(["white", "black"]),
  phase: z.enum(["aiming", "match_ended"]),
  shotNumber: z.number().int(),
  scores: z.object({ white: z.number().int(), black: z.number().int() }),
  queue: z.array(coinSchema),
});
export type NextState = z.infer<typeof nextStateSchema>;

/** The full state of a match, for a spectator who has just arrived. */
export const snapshotSchema = z.object({
  type: z.literal("snapshot"),
  matchId: z.string(),
  status: z.enum(["live", "finished", "void"]),
  board: z.number().int(),
  turn: z.enum(["white", "black"]),
  turnSeat: z.union([z.literal(1), z.literal(2), z.literal(0)]),
  phase: z.enum(["aiming", "match_ended"]),
  shotNumber: z.number().int(),
  turnEndsAt: z.number().int(),
  queenOnBoard: z.boolean(),
  queenPendingSeat: z.union([z.literal(1), z.literal(2), z.literal(0)]),
  scores: z.object({ white: z.number().int(), black: z.number().int() }),
  seats: z.array(seatSchema),
  coins: z.array(coinSchema),
  seedCommit: z.string(),
});
export type SnapshotMessage = z.infer<typeof snapshotSchema>;

/**
 * A shot, as spectators receive it.
 *
 * `frames` carries the recording; a shot that pocketed nothing and produced no
 * motion may carry `frameCount: 0`, so a viewer must handle an empty recording.
 */
export const shotMessageSchema = z.object({
  type: z.literal("shot"),
  shotNumber: z.number().int().positive(),
  seat: z.union([z.literal(1), z.literal(2)]),
  events: z.array(shotEventSchema),
  frames: encodedFramesSchema,
  nextState: nextStateSchema,
});
export type ShotMessage = z.infer<typeof shotMessageSchema>;

/** The match is over. No more shots follow. */
export const endMessageSchema = z.object({
  type: z.literal("end"),
  matchId: z.string(),
  winner: z.enum(["white", "black", "draw"]),
  reason: z.string(),
  scores: z.object({ white: z.number().int(), black: z.number().int() }),
  seedReveal: z.string().nullable(),
  resultSignature: z.string().nullable(),
});
export type EndMessage = z.infer<typeof endMessageSchema>;

/** Sent once when a spectator joins, before the snapshot. */
export const welcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  matchId: z.string(),
  spectate: z.literal(true),
  /** How many spectators the room holds when you joined, yourself included. */
  spectators: z.number().int().nonnegative(),
  /** The tick rate of the recording, so a renderer can pace itself. */
  fps: z.number().int().positive(),
});
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;

/** Sent to a spectator whose socket fell behind: a fresh snapshot follows. */
export const lagMessageSchema = z.object({
  type: z.literal("lag"),
  /** Shots that were skipped while this viewer was behind. */
  skippedShots: z.number().int().nonnegative(),
  reason: z.literal("slow_consumer"),
});
export type LagMessage = z.infer<typeof lagMessageSchema>;

/** The room refused something the client sent. */
export const rejectionMessageSchema = z.object({
  type: z.literal("rejected"),
  code: z.string(),
  message: z.string(),
});
export type RejectionMessage = z.infer<typeof rejectionMessageSchema>;

/** Every message a spectator can receive, and the frame decoder for its shots. */
export const spectatorMessageSchema = z.discriminatedUnion("type", [
  welcomeMessageSchema,
  snapshotSchema,
  shotMessageSchema,
  endMessageSchema,
  lagMessageSchema,
  rejectionMessageSchema,
]);
export type SpectatorMessage = z.infer<typeof spectatorMessageSchema>;

/** The message names on the wire, so a client subscribes to the right strings. */
export const STREAM_MESSAGES = {
  welcome: "welcome",
  snapshot: "snapshot",
  shot: "shot",
  end: "match_end",
  lag: "lag",
  rejected: "rejected",
  /** Ludo: the die is on the table and a seat has to choose. */
  roll: "roll",
  /** Ludo: a turn resolved. */
  move: "move",
} as const;

// ---------------------------------------------------------------------------
// REST: public reads
// ---------------------------------------------------------------------------

export const limitsSchema = z.object({
  minStakeMinor: moneySchema,
  maxStakeMinor: moneySchema,
  matchExposurePct: z.number().nonnegative(),
  largePayoutMinor: moneySchema,
  betRateLimitPerMinute: z.number().int().positive(),
  minAccountAgeHours: z.number().int().nonnegative(),
});
export type Limits = z.infer<typeof limitsSchema>;

export const configSchema = z.object({
  ok: z.literal(true),
  currency: z.string().length(3),
  moneyMode: moneyModeSchema,
  minStakeMinor: moneySchema,
  maxStakeMinor: moneySchema,
  houseMarginBps: z.number().int().nonnegative().max(10_000),
  limits: limitsSchema,
  contractVersion: z.number().int().positive(),
  /** True when real money is live, so the site can show the deposit caveat. */
  depositsEnabled: z.boolean(),
});
export type ConfigResponse = z.infer<typeof configSchema>;

export const matchSummarySchema = z.object({
  id: z.string(),
  game: z.enum(["carrom", "ludo"]),
  status: matchStatusSchema,
  tournamentId: z.string().nullable(),
  isTournament: z.boolean(),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  players: z.array(
    z.object({
      seat: z.union([z.literal(1), z.literal(2)]),
      playerId: z.string().nullable(),
      displayName: z.string(),
      isBot: z.boolean(),
      botLevel: botLevelSchema.nullable(),
      score: z.number().int().nullable(),
    }),
  ),
  scores: z.object({ white: z.number().int(), black: z.number().int() }).nullable(),
  /** The room to join as a spectator, while the match is live. */
  roomId: z.string().nullable(),
});
export type MatchSummary = z.infer<typeof matchSummarySchema>;

export const matchesResponseSchema = z.object({
  ok: z.literal(true),
  matches: z.array(matchSummarySchema),
  /** Set when there are more rows than the page returned. */
  nextCursor: z.string().nullable(),
});
export type MatchesResponse = z.infer<typeof matchesResponseSchema>;

export const matchDetailSchema = matchSummarySchema.extend({
  seedCommit: z.string().nullable(),
  /** Only after the match finished: the seed the commitment was made to. */
  seedReveal: z.string().nullable(),
  resultSignature: z.string().nullable(),
  logHeadHash: z.string().nullable(),
  result: z.looseObject({ winner: z.enum(["white", "black", "draw"]) }).nullable(),
});
export type MatchDetail = z.infer<typeof matchDetailSchema>;

export const matchResponseSchema = z.object({
  ok: z.literal(true),
  match: matchDetailSchema,
});
export type MatchResponse = z.infer<typeof matchResponseSchema>;

export const marketSelectionSchema = z.object({
  selectionKey: z.string(),
  oddsDecimal: z.number().positive(),
  status: z.enum(["open", "suspended", "settled", "void"]),
});
export const marketSchema = z.object({
  id: z.string(),
  marketType: z.string(),
  subject: z.string(),
  line: z.number().nullable(),
  name: z.string(),
  status: z.enum(["open", "suspended", "settled", "void"]),
  maxStakeMinor: moneySchema.nullable(),
  isLive: z.boolean(),
  selections: z.array(marketSelectionSchema),
});
export type Market = z.infer<typeof marketSchema>;

export const marketsResponseSchema = z.object({
  ok: z.literal(true),
  matchId: z.string(),
  markets: z.array(marketSchema),
});
export type MarketsResponse = z.infer<typeof marketsResponseSchema>;

export const playerProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  isBot: z.boolean(),
  botLevel: botLevelSchema.nullable(),
  rating: z.number().int().nullable(),
  played: z.number().int().nonnegative(),
  won: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(),
  recentResults: z.array(
    z.object({
      matchId: z.string(),
      opponent: z.string(),
      result: z.enum(["won", "lost", "draw"]),
      score: z.string(),
      endedAt: timestampSchema,
    }),
  ),
});
export type PlayerProfile = z.infer<typeof playerProfileSchema>;

export const playerResponseSchema = z.object({ ok: z.literal(true), player: playerProfileSchema });
export type PlayerResponse = z.infer<typeof playerResponseSchema>;

export const leaderboardEntrySchema = z.object({
  rank: z.number().int().positive(),
  playerId: z.string(),
  displayName: z.string(),
  isBot: z.boolean(),
  rating: z.number().int().nullable(),
  played: z.number().int().nonnegative(),
  won: z.number().int().nonnegative(),
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

export const leaderboardResponseSchema = z.object({
  ok: z.literal(true),
  entries: z.array(leaderboardEntrySchema),
});
export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>;

export const tournamentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["draft", "open", "running", "finished", "cancelled"]),
  format: z.enum(["single_elimination", "round_robin"]),
  maxPlayers: z.number().int().positive(),
  entries: z.number().int().nonnegative(),
  entryFeeMinor: moneySchema,
  prizePoolMinor: moneySchema,
  startsAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type TournamentSummary = z.infer<typeof tournamentSummarySchema>;

export const tournamentsResponseSchema = z.object({
  ok: z.literal(true),
  tournaments: z.array(tournamentSummarySchema),
});
export type TournamentsResponse = z.infer<typeof tournamentsResponseSchema>;

export const tournamentMatchSchema = z.object({
  id: z.string(),
  round: z.number().int().nonnegative(),
  slot: z.number().int().nonnegative(),
  status: z.enum(["pending", "ready", "live", "finished", "void"]),
  playerA: z.string().nullable(),
  playerB: z.string().nullable(),
  winner: z.string().nullable(),
  matchId: z.string().nullable(),
});
export type TournamentMatch = z.infer<typeof tournamentMatchSchema>;

export const tournamentResponseSchema = z.object({
  ok: z.literal(true),
  tournament: tournamentSummarySchema,
  entrants: z.array(
    z.object({
      playerId: z.string(),
      displayName: z.string(),
      isBot: z.boolean(),
      seed: z.number().int().nullable(),
      eliminatedAt: timestampSchema.nullable(),
    }),
  ),
  matches: z.array(tournamentMatchSchema),
  champion: z.string().nullable(),
});
export type TournamentResponse = z.infer<typeof tournamentResponseSchema>;

// ---------------------------------------------------------------------------
// REST: the signed-in player
// ---------------------------------------------------------------------------

export const betSchema = z.object({
  id: z.string(),
  matchId: z.string(),
  marketId: z.string(),
  marketType: z.string(),
  selectionKey: z.string(),
  stakeMinor: moneySchema,
  oddsLocked: z.number().positive(),
  potentialPayoutMinor: moneySchema,
  status: z.enum(["open", "won", "lost", "void", "pending_review", "rejected"]),
  payoutMinor: moneySchema.nullable(),
  placedAt: timestampSchema,
  settledAt: timestampSchema.nullable(),
});
export type Bet = z.infer<typeof betSchema>;

export const betsResponseSchema = z.object({
  ok: z.literal(true),
  bets: z.array(betSchema),
  nextCursor: z.string().nullable(),
});
export type BetsResponse = z.infer<typeof betsResponseSchema>;

export const walletResponseSchema = z.object({
  ok: z.literal(true),
  currency: z.string().length(3),
  availableMinor: moneySchema,
  /** Staked and not yet settled: money at risk, not available. */
  atRiskMinor: moneySchema,
  /** Withdrawals requested and not yet paid or refused. */
  pendingWithdrawalMinor: moneySchema,
  totalBalanceMinor: moneySchema,
});
export type WalletResponse = z.infer<typeof walletResponseSchema>;

export const transactionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  amountMinor: moneySchema,
  balanceAfterMinor: moneySchema,
  createdAt: timestampSchema,
});
export type Transaction = z.infer<typeof transactionSchema>;

export const transactionsResponseSchema = z.object({
  ok: z.literal(true),
  currency: z.string().length(3),
  transactions: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});
export type TransactionsResponse = z.infer<typeof transactionsResponseSchema>;

// ---------------------------------------------------------------------------
// Query parameters, so both sides validate the same things
// ---------------------------------------------------------------------------

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(128).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export const matchesQuerySchema = pageQuerySchema.extend({
  game: z.enum(["carrom", "ludo"]).optional(),
  tournamentId: z.string().max(64).optional(),
});
export type MatchesQuery = z.infer<typeof matchesQuerySchema>;

export const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  bots: z
    .enum(["include", "exclude", "only"])
    .default("include")
    .transform((value) => value),
});
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

// ---------------------------------------------------------------------------
// Ludo: the stream
// ---------------------------------------------------------------------------

/**
 * The roll, broadcast when the server has thrown the die.
 *
 * A player answers it with `{ type: "move", tokenIndex }`, choosing one of
 * `tokens`: those are the tokens that have a legal move, so a client shows exactly
 * the choices the referee will accept.
 */
export const ludoRollMessageSchema = z.strictObject({
  type: z.literal("roll"),
  matchId: z.string().min(1),
  /** The seat to play, 1 to 4. */
  seat: z.number().int().min(1).max(4),
  roll: z.number().int().min(1).max(6),
  /** The token numbers that may move with this roll. */
  tokens: z.array(z.number().int().min(0).max(3)),
  moveNumber: z.number().int().min(0),
  /** Seconds the seat has to choose. */
  moveSeconds: z.number().int().min(1),
  /** True when this is the third six in a row and the turn is already lost. */
  forfeited: z.boolean(),
});
export type LudoRollMessage = z.infer<typeof ludoRollMessageSchema>;

/** The token a client wants to move. */
export const ludoMoveCommandSchema = z.strictObject({
  type: z.literal("move"),
  tokenIndex: z.number().int().min(0).max(3),
});
export type LudoMoveCommand = z.infer<typeof ludoMoveCommandSchema>;

/** A resolved turn: what moved, and the events it produced. */
export const ludoMoveMessageSchema = z.strictObject({
  type: z.literal("move"),
  matchId: z.string().min(1),
  seat: z.number().int().min(1).max(4),
  roll: z.number().int().min(1).max(6),
  moveNumber: z.number().int().min(1),
  /** The token that moved, or null when the turn passed. */
  token: z.number().int().min(0).max(3).nullable(),
  from: z.number().int().min(-1).max(57).nullable(),
  to: z.number().int().min(-1).max(57).nullable(),
  /** One word per event, in order: token_out, capture, token_home, and so on. */
  events: z.array(z.string().min(1)),
  /** Who plays next. */
  turnSeat: z.number().int().min(1).max(4),
  /** True when the same seat rolls again. */
  extraRoll: z.boolean(),
});
export type LudoMoveMessage = z.infer<typeof ludoMoveMessageSchema>;

/** The whole board, for a viewer that has just arrived. */
export const ludoSnapshotMessageSchema = z.strictObject({
  type: z.literal("snapshot"),
  matchId: z.string().min(1),
  status: z.enum(["playing", "finished"]),
  turnSeat: z.number().int().min(1).max(4),
  roll: z.number().int().min(0).max(6),
  moveNumber: z.number().int().min(0),
  seeds: z.object({ commit: z.string().min(1), reveal: z.string().nullable() }),
  seats: z.array(
    z.strictObject({
      seat: z.number().int().min(1).max(4),
      displayName: z.string(),
      isBot: z.boolean(),
      botPolicy: z.string().nullable(),
      connected: z.boolean(),
      home: z.number().int().min(0).max(4),
      /** Progress per token: `-1` yard, `0..56` on the board, `57` home. */
      progress: z.array(z.number().int().min(-1).max(57)),
    }),
  ),
  finishingOrder: z.array(z.number().int().min(1).max(4)),
});
export type LudoSnapshotMessage = z.infer<typeof ludoSnapshotMessageSchema>;
