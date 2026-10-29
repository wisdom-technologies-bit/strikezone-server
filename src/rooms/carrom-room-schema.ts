import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * The room state every client receives.
 *
 * It carries what a player or a spectator needs to follow the match and nothing
 * they must not have: scores, board, coins on the table, whose turn it is, the
 * clock, and each seat's `isBot` flag. The seed is never in here; only its
 * commitment is, which is public by design.
 *
 * Declared with @colyseus/schema 5's `schema()` builder rather than decorators,
 * which keeps the project's plain TypeScript settings and needs no experimental
 * compiler flags.
 */

/** One seat, as published. */
export const CarromSeatState = schema(
  {
    seat: t.number().default(1),
    playerId: t.string().default(""),
    displayName: t.string().default(""),
    /** Always true for a bot. A bot is never shown as human anywhere. */
    isBot: t.boolean().default(false),
    /** The bot policy id, for example carrom_master, or empty for a human. */
    botPolicy: t.string().default(""),
    score: t.number().default(0),
    pocketed: t.number().default(0),
    timeouts: t.number().default(0),
    connected: t.boolean().default(false),
  },
  "CarromSeatState",
);

/** One coin on the table. */
export const CarromCoinState = schema(
  {
    id: t.string().default(""),
    colour: t.string().default(""),
    x: t.number().default(0),
    y: t.number().default(0),
  },
  "CarromCoinState",
);

/** The whole room state. */
export const CarromRoomState = schema(
  {
    matchId: t.string().default(""),
    status: t.string().default("live"),
    board: t.number().default(1),
    turn: t.string().default("white"),
    turnSeat: t.number().default(1),
    phase: t.string().default("aiming"),
    shotNumber: t.number().default(0),
    /** Epoch milliseconds when the human on turn runs out of time; 0 for a bot. */
    turnEndsAt: t.number().default(0),
    /** Seconds a human has per turn, as this room was configured. */
    turnSeconds: t.number().default(30),
    queenOnBoard: t.boolean().default(true),
    /** 0 when no queen is pending, otherwise the seat that owes the cover. */
    queenPendingSeat: t.number().default(0),
    /** The published commitment. Never the seed. */
    seedCommit: t.string().default(""),
    coins: t.array(CarromCoinState),
    seats: t.map(CarromSeatState),
  },
  "CarromRoomState",
);

/** The instance type of the room state. */
export type CarromRoomStateInstance = SchemaType<typeof CarromRoomState>;
