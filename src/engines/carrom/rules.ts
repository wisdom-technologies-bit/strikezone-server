// Informed by reading samiranrl/Carrom_rl (GPL v3) for the rules, board layout
// and shot interface only. This code is original: no line is copied, translated
// or paraphrased from that project. See docs/carrom-rules.md.

import type { CarromConfig } from "./config.js";
import type { ShotOutcome } from "./physics.js";
import { coinRadius, createInitialCoins, findFreeSpot, opposite } from "./setup.js";
import type {
  CarromCoin,
  CarromColour,
  CarromEvent,
  CarromFoulReason,
  CarromPlayerState,
  CarromQueenState,
  CarromQueenReturnReason,
  CarromState,
} from "./types.js";

/** A writable view of a readonly state fragment, used only inside this module. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What a resolved shot produced: the next state and what happened on the way. */
export interface ResolvedShot {
  readonly state: CarromState;
  readonly events: readonly CarromEvent[];
}

/**
 * Applies the rules of singles carrom to a finished shot.
 *
 * Pure: takes the state before the shot plus the physics outcome, and returns a
 * new state. No physics, no clock and no randomness, so the rules can be tested
 * with a made-up outcome and the same function serves the room, the bot trainer
 * and the simulator.
 */
export function resolveShot(
  state: CarromState,
  outcome: ShotOutcome,
  config: CarromConfig,
): ResolvedShot {
  const shot = state.shot + 1;
  const events: CarromEvent[] = [];
  const me = state.turn;
  const them = opposite(me);

  const players: Record<CarromColour, Mutable<CarromPlayerState>> = {
    white: { ...state.players.white },
    black: { ...state.players.black },
  };
  const coins: CarromCoin[] = outcome.coins.map((coin) => ({ ...coin }));
  const queen: Mutable<CarromQueenState> = { ...state.queen };

  const coinDrops = outcome.pocketed.filter((body) => body.kind === "coin");
  const queenPocketed = coinDrops.some((body) => body.colour === "queen");
  const strikerPocketed = outcome.pocketed.some((body) => body.kind === "striker");
  const ownDropped = coinDrops.filter((body) => body.colour === me);
  const opponentDropped = coinDrops.filter((body) => body.colour === them);

  const foulReason: CarromFoulReason | null = strikerPocketed
    ? "striker_pocketed"
    : opponentDropped.length > 0
      ? "opponent_coin_pocketed"
      : null;

  if (queenPocketed) {
    queen.onBoard = false;
  }

  resolveQueen();

  if (foulReason !== null) {
    applyFoul();
  } else {
    creditOwnCoins();
    creditOpponentCoins();
  }

  const keepTurn = foulReason === null && (ownDropped.length > 0 || queen.pending === me);

  const finisher = findFinisher(players, config);
  const queenBlocksBoardEnd = queen.pending !== null;

  if (finisher !== null && !queenBlocksBoardEnd) {
    return endBoard(finisher);
  }

  return {
    state: {
      ...state,
      shot,
      turn: keepTurn ? me : them,
      coins,
      striker: outcome.striker,
      queen,
      players,
      phase: "aiming",
    },
    events: keepTurn ? events : [...events, { type: "turn_changed", shot, from: me, to: them }],
  };

  // --------------------------------------------------------------------------
  // The queen, in her own words: she may only be taken once you hold one of your
  // own coins, and she must be covered before the turn ends.
  // --------------------------------------------------------------------------
  function resolveQueen(): void {
    if (queenPocketed) {
      if (foulReason !== null) {
        returnQueen("foul");
        return;
      }
      const heldBefore = players[me].pocketed > 0;
      if (!heldBefore && ownDropped.length === 0) {
        returnQueen("no_own_coin");
        return;
      }
      events.push({ type: "queen_pocketed", shot, by: me });
      if (ownDropped.length > 0) {
        queen.coveredBy = me;
        queen.pending = null;
        events.push({ type: "queen_covered", shot, by: me });
      } else {
        queen.pending = me;
      }
      return;
    }

    // A queen pocketed on an earlier stroke of this turn is still to be covered.
    if (queen.pending !== me) {
      return;
    }
    if (foulReason !== null) {
      returnQueen("foul");
      return;
    }
    if (ownDropped.length > 0) {
      queen.pending = null;
      queen.coveredBy = me;
      events.push({ type: "queen_covered", shot, by: me });
      return;
    }
    returnQueen("not_covered");
  }

  function returnQueen(reason: CarromQueenReturnReason): void {
    queen.pending = null;
    queen.onBoard = true;
    placeOnCentre("queen", "queen");
    events.push({ type: "queen_returned", shot, reason });
  }

  // --------------------------------------------------------------------------
  // Fouls: the stroke earns nothing, the offender pays a coin, the turn ends.
  // --------------------------------------------------------------------------
  function applyFoul(): void {
    if (foulReason === null) {
      return;
    }
    events.push({ type: "foul", shot, by: me, reason: foulReason });

    // Own coins pocketed on a fouling stroke go back to the centre.
    for (const dropped of ownDropped) {
      placeOnCentre(dropped.id, me);
    }

    // An opponent's coin stays pocketed and counts for them.
    for (const dropped of opponentDropped) {
      players[them].pocketed = Math.min(config.coinsPerSide, players[them].pocketed + 1);
      events.push({
        type: "coin_pocketed",
        shot,
        coin: them,
        creditedTo: them,
        by: me,
        coinId: dropped.id,
      });
    }

    // Penalty: one already-pocketed own coin returns, or the debt is recorded.
    if (players[me].pocketed > 0) {
      players[me].pocketed -= 1;
      const returned = nextCoinOffBoard(me);
      placeOnCentre(returned, me);
    } else {
      players[me].owed += 1;
    }
  }

  function creditOwnCoins(): void {
    for (const dropped of ownDropped) {
      if (players[me].owed > 0) {
        // Settle an outstanding penalty with this coin instead of keeping it.
        players[me].owed -= 1;
        placeOnCentre(dropped.id, me);
      } else {
        players[me].pocketed = Math.min(config.coinsPerSide, players[me].pocketed + 1);
      }
      events.push({
        type: "coin_pocketed",
        shot,
        coin: me,
        creditedTo: me,
        by: me,
        coinId: dropped.id,
      });
    }
  }

  function creditOpponentCoins(): void {
    // Unreachable without a foul, kept so the intent is explicit.
    for (const dropped of opponentDropped) {
      players[them].pocketed = Math.min(config.coinsPerSide, players[them].pocketed + 1);
      events.push({
        type: "coin_pocketed",
        shot,
        coin: them,
        creditedTo: them,
        by: me,
        coinId: dropped.id,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Positions for coins that come back onto the board.
  // --------------------------------------------------------------------------
  function placeOnCentre(id: string, colour: CarromCoin["colour"]): void {
    const spot = findFreeSpot(coins, coinRadius(config), config);
    coins.push({ id, colour, x: spot.x, y: spot.y });
    if (id === "queen") {
      queen.onBoard = true;
    }
  }

  /** The highest-numbered own coin that is not on the board: a pocketed one. */
  function nextCoinOffBoard(colour: CarromColour): string {
    const onBoard = new Set(coins.map((coin) => coin.id));
    const prefix = colour === "white" ? "w" : "b";
    for (let index = config.coinsPerSide; index >= 1; index -= 1) {
      const id = `${prefix}${index}`;
      if (!onBoard.has(id)) {
        return id;
      }
    }
    return `${prefix}1`;
  }

  // --------------------------------------------------------------------------
  // Board and match end.
  // --------------------------------------------------------------------------
  function findFinisher(
    tallies: Record<CarromColour, Mutable<CarromPlayerState>>,
    settings: CarromConfig,
  ): CarromColour | null {
    if (tallies[me].pocketed >= settings.coinsPerSide) {
      return me;
    }
    if (tallies[them].pocketed >= settings.coinsPerSide) {
      return them;
    }
    return null;
  }

  function endBoard(winner: CarromColour): ResolvedShot {
    const loser = opposite(winner);
    const opponentCoinsLeft = Math.max(0, config.coinsPerSide - players[loser].pocketed);
    const queenPoints = queen.coveredBy === winner ? config.queenPoints : 0;
    const points = opponentCoinsLeft + queenPoints;
    players[winner].score += points;

    events.push({
      type: "board_ended",
      shot,
      winner,
      points,
      opponentCoinsLeft,
      queenPoints,
    });

    const matchOver =
      players[winner].score >= config.pointsToWinMatch || state.board >= config.boardsPerMatch;

    if (matchOver) {
      const whiteScore = players.white.score;
      const blackScore = players.black.score;
      const matchWinner: CarromColour | "tie" =
        whiteScore === blackScore ? "tie" : whiteScore > blackScore ? "white" : "black";
      events.push({
        type: "match_ended",
        shot,
        winner: matchWinner,
        scores: { white: whiteScore, black: blackScore },
      });

      return {
        state: {
          ...state,
          shot,
          coins,
          striker: outcome.striker,
          queen,
          players,
          phase: "match_ended",
        },
        events,
      };
    }

    const nextBoard = state.board + 1;
    const breaker: CarromColour = nextBoard % 2 === 1 ? "white" : "black";

    return {
      state: {
        ...state,
        board: nextBoard,
        shot,
        turn: breaker,
        phase: "aiming",
        queen: { onBoard: true, coveredBy: null, pending: null },
        coins: createInitialCoins(config),
        striker: null,
        players: {
          white: { score: players.white.score, pocketed: 0, owed: 0 },
          black: { score: players.black.score, pocketed: 0, owed: 0 },
        },
      },
      events,
    };
  }
}
