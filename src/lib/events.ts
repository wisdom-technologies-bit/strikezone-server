import { logger } from "./logger.js";

/**
 * The application event bus.
 *
 * Tournaments and rooms publish; anything that cares subscribes. It is a plain
 * in-process emitter on purpose: every subscriber in this codebase is either in
 * the same process (the tournament scheduler, the wallet) or a room broadcasting
 * to clients, so a message broker would add a failure mode without adding a
 * capability.
 *
 * Two rules hold this together:
 *
 * 1. Payloads are typed per event name. `publish("match.finished", ...)` only
 *    compiles with the payload `match.finished` declares, so a producer cannot
 *    quietly change a field out from under a subscriber.
 * 2. A subscriber cannot break the publisher. Every handler runs in its own
 *    try/catch (including async ones) and a failure is logged, never rethrown:
 *    a broken listener on `match.finished` must not stop the next listener, and
 *    must not fail the match.
 *
 * Hard rule 4 lives here too: game rooms and bots must never subscribe to
 * betting events. The betting side publishes its own names (see
 * `BETTING_EVENT_NAMES`) and the ESLint config blocks rooms, engines and
 * tournaments from importing it.
 */

/** A match was created. Published before anyone plays. */
export interface MatchCreatedPayload {
  readonly matchId: string;
  readonly game: "carrom" | "ludo";
  /** The tournament this match belongs to, or null for a standalone match. */
  readonly tournamentId: string | null;
  /** The players seated, in seat order. */
  readonly playerIds: readonly string[];
  readonly isBot: readonly boolean[];
}

/** A match started: the room is up and the referee has begun. */
export interface MatchLivePayload {
  readonly matchId: string;
  readonly game: "carrom" | "ludo";
  readonly tournamentId: string | null;
  readonly startedAt: string;
}

/**
 * A shot has been received and is about to be simulated.
 *
 * Published *before* any frame of that shot leaves the server, so a trading desk
 * (or the odds engine) can suspend the market at the instant the shot is known
 * and before the world can see where it went. That ordering is the fairness
 * guarantee the betting side relies on, which is why it is a separate event from
 * `match.shot` rather than a field on it.
 */
export interface ShotReceivedPayload {
  readonly matchId: string;
  readonly game: "carrom" | "ludo";
  readonly seat: 1 | 2 | 3 | 4;
  /** Who produced it. A timeout is not a human decision and a bot is not either. */
  readonly source: "human" | "bot" | "timeout";
  /** The shot number this will become, so a subscriber can key its own state. */
  readonly shotNumber: number;
}

/** A shot was played. The odds engine suspends and reprices on these. */
export interface MatchShotPayload {
  readonly matchId: string;
  readonly game: "carrom" | "ludo";
  /** The seat, 1 to 4: carrom uses two, ludo four. */
  readonly seat: 1 | 2 | 3 | 4;
  /** How many shots the match has now played, counting this one. */
  readonly shotNumber: number;
}

/**
 * A Ludo move is known, before the next roll is broadcast.
 *
 * The counterpart of `shot.received`: whoever prices a Ludo market learns which
 * token moved, with which roll, before the board can move again.
 */
export interface MoveReceivedPayload {
  readonly matchId: string;
  readonly game: "carrom" | "ludo";
  readonly seat: 1 | 2 | 3 | 4;
  /** How many turns the match has resolved, counting this one. */
  readonly moveNumber: number;
  /** The token that moved, or null when the turn passed without a move. */
  readonly token: number | null;
  readonly roll: number;
}

/** A match finished, with the signed result. */
export interface MatchFinishedPayload {
  readonly matchId: string;
  readonly game: "carrom" | "ludo";
  readonly tournamentId: string | null;
  readonly winnerPlayerId: string | null;
  readonly loserPlayerId: string | null;
  readonly reason: "scored" | "forfeit" | "board_limit" | "walkover";
  readonly scores: { readonly white: number; readonly black: number };
}

/**
 * A match is over and its markets can be settled. Published by the odds engine
 * with the stats every market settles against; settlement itself belongs to the
 * betting side, which is why this carries data and never a decision.
 */
export interface MarketsReadyToSettlePayload {
  readonly matchId: string;
  readonly game: "carrom" | "ludo";
  readonly winner: "white" | "black" | "tie" | null;
  readonly boardsPlayed: number;
  readonly totalPoints: number;
  readonly totalFouls: number;
}

/** Registration opened for a tournament. */
export interface TournamentOpenedPayload {
  readonly tournamentId: string;
  readonly game: "carrom" | "ludo";
  readonly opensAt: string;
  readonly closesAt: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
}

/** The bracket exists: seeding is done and round one positions are filled. */
export interface TournamentBracketReadyPayload {
  readonly tournamentId: string;
  readonly format: string;
  readonly entrants: number;
  readonly rounds: number;
  readonly byes: number;
  /** Seeds in bracket order, 1-based, with null for an empty slot. */
  readonly seeds: readonly (number | null)[];
}

/** A round started: its matches exist and are due. */
export interface TournamentRoundStartedPayload {
  readonly tournamentId: string;
  readonly round: number;
  readonly matches: readonly {
    readonly bracketMatchId: string;
    readonly slot: number;
    readonly playerIds: readonly (string | null)[];
  }[];
}

/** A tournament finished, with what was paid to whom. */
export interface TournamentFinishedPayload {
  readonly tournamentId: string;
  readonly championPlayerId: string;
  readonly prizePoolMinor: number;
  readonly rakeMinor: number;
  readonly payouts: readonly { readonly playerId: string; readonly amountMinor: number }[];
}

/** A tournament was cancelled and every entry fee refunded. */
export interface TournamentCancelledPayload {
  readonly tournamentId: string;
  readonly reason: string;
  readonly refundedEntries: number;
  readonly refundedMinor: number;
}

/** Every event this module knows, and the payload it carries. */
export interface EventPayloads {
  "match.created": MatchCreatedPayload;
  "match.live": MatchLivePayload;
  "match.shot": MatchShotPayload;
  "shot.received": ShotReceivedPayload;
  "move.received": MoveReceivedPayload;
  "match.finished": MatchFinishedPayload;
  "markets.ready_to_settle": MarketsReadyToSettlePayload;
  "tournament.opened": TournamentOpenedPayload;
  "tournament.bracket_ready": TournamentBracketReadyPayload;
  "tournament.round_started": TournamentRoundStartedPayload;
  "tournament.finished": TournamentFinishedPayload;
  "tournament.cancelled": TournamentCancelledPayload;
}

/** An event name. */
export type EventName = keyof EventPayloads;

/** The names, for tests and for tooling that wants to enumerate them. */
export const EVENT_NAMES: readonly EventName[] = [
  "match.created",
  "match.live",
  "match.shot",
  "shot.received",
  "move.received",
  "match.finished",
  "markets.ready_to_settle",
  "tournament.opened",
  "tournament.bracket_ready",
  "tournament.round_started",
  "tournament.finished",
  "tournament.cancelled",
];

/**
 * The names the betting side owns. Nothing in this module publishes or
 * subscribes to them; they are listed so a reviewer can see the boundary that
 * hard rule 4 draws, and so a room that tries to use one is easy to spot.
 */
export const BETTING_EVENT_NAMES = [
  "bet.placed",
  "bet.settled",
  "market.opened",
  "market.suspended",
  "market.settled",
  "liability.changed",
] as const;

/** A handler for one event. May be async; failures are caught and logged. */
export type EventHandler<K extends EventName> = (payload: EventPayloads[K]) => void | Promise<void>;

const handlers = new Map<EventName, Set<EventHandler<EventName>>>();

function isEventName(name: string): name is EventName {
  return (EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * Subscribes to one event. Returns an unsubscribe function.
 *
 * The returned function is safe to call more than once and safe to call while
 * the event is being delivered.
 */
export function subscribe<K extends EventName>(name: K, handler: EventHandler<K>): () => void {
  if (!isEventName(name)) {
    throw new Error(`unknown event ${String(name)}`);
  }

  const set = handlers.get(name) ?? new Set<EventHandler<EventName>>();
  const stored = handler as EventHandler<EventName>;
  set.add(stored);
  handlers.set(name, set);

  return () => {
    const current = handlers.get(name);
    current?.delete(stored);
    if (current !== undefined && current.size === 0) {
      handlers.delete(name);
    }
  };
}

/**
 * Publishes one event to every subscriber.
 *
 * Delivery is synchronous for synchronous handlers, and async handlers are
 * awaited in order, so a test that publishes can await before asserting.
 */
export async function publish<K extends EventName>(
  name: K,
  payload: EventPayloads[K],
): Promise<void> {
  if (!isEventName(name)) {
    throw new Error(`unknown event ${String(name)}`);
  }

  const set = handlers.get(name);
  if (set === undefined) {
    return;
  }

  // Copy first: a handler may subscribe or unsubscribe while being delivered.
  for (const handler of [...set]) {
    try {
      await handler(payload);
    } catch (error) {
      logger.error({ err: error, event: name }, "event handler failed");
    }
  }
}

/**
 * Publishes without waiting, for callers that must not be slowed by a
 * subscriber. Failures are still logged inside `publish`.
 */
export function publishLater<K extends EventName>(name: K, payload: EventPayloads[K]): void {
  void publish(name, payload).catch((error: unknown) => {
    logger.error({ err: error, event: name }, "event publish failed");
  });
}

/** How many subscribers an event has. Used by tests. */
export function listenerCount(name: EventName): number {
  return handlers.get(name)?.size ?? 0;
}

/** Drops every subscriber. Used by tests, never by the server. */
export function clearSubscribers(): void {
  handlers.clear();
}
