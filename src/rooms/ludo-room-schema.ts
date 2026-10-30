import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * The Colyseus state of a Ludo room.
 *
 * Clients get the whole board through this schema rather than a message per
 * change: four seats, sixteen tokens, the roll on the table and whose turn it is.
 * The referee's own state lives in the runner; this is the projection it writes
 * after every turn, and it is what the dev viewer draws.
 *
 * Declared with @colyseus/schema 5's `schema()` builder, like the Carrom room, so
 * the project needs no experimental decorator settings.
 */

/** One seat: who holds it, and where its tokens are. */
export const LudoSeatState = schema(
  {
    seat: t.number().default(1),
    playerId: t.string().default(""),
    displayName: t.string().default(""),
    /** Always true for a bot. A bot is never shown as human anywhere. */
    isBot: t.boolean().default(false),
    /** The published policy id, or empty for a human. */
    botPolicy: t.string().default(""),
    connected: t.boolean().default(false),
    /** How many tokens are home, which is what a viewer counts. */
    home: t.number().default(0),
    /** How many times this seat has let its clock run out. */
    timeouts: t.number().default(0),
    /** Progress per token: `-1` yard, `0..56` on the board, `57` home. */
    progress: t.array("int8"),
  },
  "LudoSeatState",
);

/** The whole room state. */
export const LudoRoomState = schema(
  {
    matchId: t.string().default(""),
    /** The published commitment. Never the seed. */
    seedCommit: t.string().default(""),
    status: t.string().default("playing"),
    /** The seat to play, 1 to 4. */
    turnSeat: t.number().default(1),
    /** The roll on the table, or 0 before the first one. */
    roll: t.number().default(0),
    /** How many turns have resolved. */
    moveNumber: t.number().default(0),
    /** Seconds the acting seat has to choose. */
    moveSeconds: t.number().default(20),
    /** Epoch milliseconds when the acting human runs out of time; 0 for a bot. */
    turnEndsAt: t.number().default(0),
    finishingOrder: t.array("uint8"),
    players: t.map(LudoSeatState),
  },
  "LudoRoomState",
);

/** The instance type of the room state. */
export type LudoRoomStateInstance = SchemaType<typeof LudoRoomState>;
