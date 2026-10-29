import { matchMaker } from "colyseus";
import type { BotLevel } from "../engines/carrom/bot-config.js";
import { logger } from "../lib/logger.js";
import type { TournamentGame } from "./types.js";

/**
 * Starting the game for a match.
 *
 * The tournament decides that a match should be played; the launcher opens the
 * room that plays it. It is an interface because the scheduler has to be able to
 * run in a test with no Colyseus server at all: there, a launcher simply records
 * what it was asked to start.
 *
 * Only Carrom has a room today. A Ludo room slots in here by name, and nothing
 * else in the tournament code changes.
 */

/** One seat to open a room with. */
export interface LaunchSeat {
  readonly kind: "human" | "bot";
  readonly playerId: string;
  readonly level: BotLevel | null;
}

/** Everything a launcher needs. */
export interface LaunchInput {
  readonly matchId: string;
  readonly game: TournamentGame;
  readonly seed: string;
  readonly seats: readonly LaunchSeat[];
  readonly turnSeconds: number;
  readonly allowSpectators: boolean;
}

/** What starting a match returns. */
export interface LaunchResult {
  readonly roomId: string;
}

/** Starts the game for a match. */
export interface MatchLauncher {
  launch(input: LaunchInput): Promise<LaunchResult>;
}

/** The room type per game. A Ludo room is added to this map when it exists. */
const ROOM_NAMES: Readonly<Record<TournamentGame, string>> = {
  carrom: "carrom",
  ludo: "ludo",
};

/** The production launcher: creates a Colyseus room with the match's seed. */
export const colyseusLauncher: MatchLauncher = {
  async launch(input: LaunchInput): Promise<LaunchResult> {
    const roomName = ROOM_NAMES[input.game];

    const created = await matchMaker.createRoom(roomName, {
      matchId: input.matchId,
      seed: input.seed,
      seats: input.seats.map((seat) =>
        seat.kind === "bot"
          ? { kind: "bot" as const, level: seat.level ?? "club" }
          : { kind: "human" as const, playerId: seat.playerId },
      ),
      turnSeconds: input.turnSeconds,
      allowSpectators: input.allowSpectators,
    });

    logger.info(
      { matchId: input.matchId, roomId: created.roomId, game: input.game },
      "tournament match launched",
    );

    return { roomId: created.roomId };
  },
};
