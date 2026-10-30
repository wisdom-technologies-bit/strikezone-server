import {
  encodeFrames,
  type EndMessage,
  type NextState,
  type ShotMessage,
  type SnapshotMessage,
} from "../api/contract.js";
import type { BotLevel } from "../engines/carrom/bot-config.js";
import type { CarromEvent } from "../engines/carrom/types.js";
import type { MatchResult } from "../lib/match-repository.js";
import type { ShotBroadcast } from "./carrom-match-runner.js";
import type { CarromRoomStateInstance } from "./carrom-room-schema.js";

/**
 * Turns the room and the referee into the messages the contract describes.
 *
 * These are pure functions of what the room already holds, so what a spectator
 * receives can be asserted without a socket: the tests build a state, call the
 * builder, and decode the frames with the same decoder the website uses.
 */

/** The bot level a policy id belongs to, or null when the seat is human. */
function botLevelOf(isBot: boolean, policy: string | undefined): BotLevel | null {
  if (!isBot) {
    return null;
  }
  return policy === "rookie" || policy === "club" || policy === "master" ? policy : null;
}

/** The full state, as a spectator who has just joined receives it. */
export function buildSnapshot(state: CarromRoomStateInstance): SnapshotMessage {
  const seats = [...state.seats.values()]
    .sort((left, right) => left.seat - right.seat)
    .map((seat) => ({
      seat: seat.seat === 2 ? (2 as const) : (1 as const),
      playerId: seat.playerId === "" ? null : seat.playerId,
      displayName: seat.displayName,
      isBot: seat.isBot,
      botLevel: botLevelOf(seat.isBot, seat.botPolicy),
      score: seat.score,
      connected: seat.connected,
    }));

  const scoreOf = (seat: 1 | 2): number =>
    seats.find((candidate) => candidate.seat === seat)?.score ?? 0;

  return {
    type: "snapshot",
    matchId: state.matchId,
    status: state.status === "finished" ? "finished" : state.status === "void" ? "void" : "live",
    board: state.board,
    turn: state.turn === "black" ? "black" : "white",
    turnSeat: state.turnSeat === 1 || state.turnSeat === 2 ? state.turnSeat : 0,
    phase: state.phase === "match_ended" ? "match_ended" : "aiming",
    shotNumber: state.shotNumber,
    turnEndsAt: state.turnEndsAt,
    queenOnBoard: state.queenOnBoard,
    queenPendingSeat:
      state.queenPendingSeat === 1 || state.queenPendingSeat === 2 ? state.queenPendingSeat : 0,
    scores: { white: scoreOf(1), black: scoreOf(2) },
    seats,
    coins: state.coins.map((coin) => ({
      id: coin.id,
      colour: coin.colour === "queen" ? "queen" : coin.colour === "black" ? "black" : "white",
      x: coin.x,
      y: coin.y,
    })),
    seedCommit: state.seedCommit,
  };
}

/** One shot, with its frames quantised for the wire. */
export function buildShotMessage(broadcast: ShotBroadcast): ShotMessage {
  const nextState: NextState = {
    board: broadcast.nextState.board,
    turn: broadcast.nextState.turn,
    phase: broadcast.nextState.phase,
    shotNumber: broadcast.shotNumber,
    scores: broadcast.nextState.scores,
    queue: broadcast.nextState.queue.map((coin) => ({
      id: coin.id,
      colour: coin.colour === "queen" ? "queen" : coin.colour === "black" ? "black" : "white",
      x: coin.x,
      y: coin.y,
    })),
  };

  const frames =
    broadcast.frames === null
      ? { fps: 30, bodyIds: [], frameCount: 0, data: "" }
      : encodeFrames({
          fps: broadcast.frames.fps,
          frames: broadcast.frames.frames.map((frame) => ({
            t: frame.t,
            bodies: frame.bodies.map((body) => ({ id: body.id, x: body.x, y: body.y })),
          })),
        });

  return {
    type: "shot",
    shotNumber: broadcast.shotNumber,
    seat: broadcast.seat,
    events: broadcast.events.map((event: CarromEvent) => ({ ...event })),
    frames,
    nextState,
  };
}

/** The end of a match, with the seed revealed if the server recorded one. */
export function buildEndMessage(
  result: MatchResult,
  extras: {
    readonly matchId: string;
    readonly seedReveal: string | null;
    readonly resultSignature: string | null;
  },
): EndMessage {
  return {
    type: "end",
    matchId: extras.matchId,
    // The stored result names the winner by seat and calls a draw a tie; the
    // contract says it in colours, so the mapping lives here and nowhere else.
    winner:
      result.winnerColour === "tie" ? "draw" : result.winnerColour === "black" ? "black" : "white",
    reason: result.reason,
    scores: result.scores,
    seedReveal: extras.seedReveal,
    resultSignature: extras.resultSignature,
  };
}
