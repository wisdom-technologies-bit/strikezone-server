/**
 * MatchStats: everything a market can be settled against, derived once from the
 * event log.
 *
 * The odds engine never reads the board. It reads the log the room already
 * wrote, so a price and a settlement always describe the same facts.
 */

export type Colour = "white" | "black";
export type MatchWinner = Colour | "tie";

export interface PlayerStats {
  readonly colour: Colour;
  readonly playerId: string;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly points: number;
  readonly boardsWon: number;
  readonly coins: number;
  readonly opponentCoins: number;
  readonly fouls: number;
  readonly strikerPockets: number;
  readonly shots: number;
  readonly queenTakes: number;
  readonly queenCovers: number;
  /** Largest board lead this player ever held (never negative). */
  readonly bestLead: number;
  /** True once the player has trailed by at least one board. */
  readonly everTrailed: boolean;
}

export interface BoardStats {
  readonly board: number;
  readonly winner: Colour | null;
  readonly points: number;
  readonly queenTaker: Colour | null;
  readonly queenCovered: boolean;
  readonly queenPoints: number;
  readonly coins: Readonly<Record<Colour, number>>;
  readonly fouls: Readonly<Record<Colour, number>>;
  readonly shots: number;
  readonly scoreAfter: Readonly<Record<Colour, number>>;
  readonly leaderAfter: MatchWinner;
}

export interface MatchStats {
  readonly matchId: string;
  readonly players: Readonly<Record<Colour, PlayerStats>>;
  readonly boards: readonly BoardStats[];
  readonly boardsPlayed: number;
  /** Null while the match is unfinished. */
  readonly winner: MatchWinner | null;
  readonly totalPoints: number;
  readonly totalFouls: number;
  readonly totalShots: number;
  /** Boards the winner took without the loser pocketing a single coin. */
  readonly whitewashBoards: number;
  readonly firstCoin: { readonly player: Colour; readonly coin: Colour } | null;
  readonly firstFoul: { readonly player: Colour; readonly board: number } | null;
  readonly strikerPocketed: boolean;
  readonly queen: {
    readonly taker: Colour;
    readonly board: number;
    readonly covered: boolean;
    readonly winsBoard: boolean;
    readonly shot: number;
  } | null;
  readonly matchMinutes: number;
  readonly finished: boolean;
}

type QueenInfo = NonNullable<MatchStats["queen"]>;

/** The same queen, marked covered: built field by field, so no union spread. */
function markCovered(value: QueenInfo): QueenInfo {
  return {
    taker: value.taker,
    board: value.board,
    covered: true,
    winsBoard: value.winsBoard,
    shot: value.shot,
  };
}

export interface MatchEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StatsOptions {
  readonly startedAt?: string | null;
  readonly endedAt?: string | null;
  /** Used when the log carries no timestamps: how long one shot takes. */
  readonly secondsPerShot?: number;
}

const COUNTERPART: Readonly<Record<Colour, Colour>> = { white: "black", black: "white" };

function colour(value: unknown, fallback: Colour): Colour {
  return value === "white" || value === "black" ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function seatFor(payload: Readonly<Record<string, unknown>>): Colour | null {
  if (payload["colour"] === "white" || payload["colour"] === "black") {
    return payload["colour"];
  }
  if (payload["seat"] === 1) {
    return "white";
  }
  if (payload["seat"] === 2) {
    return "black";
  }
  return null;
}

/**
 * Walks the log once and totals everything.
 *
 * Unfinished matches are described honestly: `finished` is false, `winner` is
 * null, and the boards only include boards that ended.
 */
export function computeMatchStats(
  matchId: string,
  events: readonly MatchEvent[],
  options: StatsOptions = {},
): MatchStats {
  const secondsPerShot = options.secondsPerShot ?? 6;

  const identity: Record<Colour, { playerId: string; displayName: string; isBot: boolean }> = {
    white: { playerId: "", displayName: "White", isBot: false },
    black: { playerId: "", displayName: "Black", isBot: false },
  };

  const points: Record<Colour, number> = { white: 0, black: 0 };
  const boardsWon: Record<Colour, number> = { white: 0, black: 0 };
  const coins: Record<Colour, number> = { white: 0, black: 0 };
  const opponentCoins: Record<Colour, number> = { white: 0, black: 0 };
  const fouls: Record<Colour, number> = { white: 0, black: 0 };
  const strikerPockets: Record<Colour, number> = { white: 0, black: 0 };
  const shots: Record<Colour, number> = { white: 0, black: 0 };
  const bestLead: Record<Colour, number> = { white: 0, black: 0 };
  const everTrailed: Record<Colour, boolean> = { white: false, black: false };
  const queenTakes: Record<Colour, number> = { white: 0, black: 0 };
  const queenCovers: Record<Colour, number> = { white: 0, black: 0 };

  const boards: BoardStats[] = [];
  let board = 1;
  let boardShots = 0;
  let boardCoins: Record<Colour, number> = { white: 0, black: 0 };
  let boardFouls: Record<Colour, number> = { white: 0, black: 0 };
  let boardQueenTaker: Colour | null = null;
  let boardQueenCovered = false;
  let totalShots = 0;

  let firstCoin: MatchStats["firstCoin"] = null;
  let firstFoul: MatchStats["firstFoul"] = null;
  let strikerPocketed = false;
  let queen: MatchStats["queen"] = null;
  let whitewashBoards = 0;
  let winner: MatchWinner | null = null;

  const flushBoard = (payload: Readonly<Record<string, unknown>>): void => {
    const boardWinner =
      payload["winner"] === "white" || payload["winner"] === "black" ? payload["winner"] : null;
    const boardPoints = num(payload["points"]);
    const queenPoints = num(payload["queenPoints"]);

    if (boardWinner !== null) {
      points[boardWinner] += boardPoints;
      boardsWon[boardWinner] += 1;
      if (boardCoins[COUNTERPART[boardWinner]] === 0) {
        whitewashBoards += 1;
      }
    }

    const lead = boardsWon.white - boardsWon.black;
    bestLead.white = Math.max(bestLead.white, lead);
    bestLead.black = Math.max(bestLead.black, -lead);
    if (lead < 0) {
      everTrailed.white = true;
    }
    if (lead > 0) {
      everTrailed.black = true;
    }

    boards.push({
      board,
      winner: boardWinner,
      points: boardPoints,
      queenTaker: boardQueenTaker,
      queenCovered: boardQueenCovered,
      queenPoints,
      coins: { ...boardCoins },
      fouls: { ...boardFouls },
      shots: boardShots,
      scoreAfter: { ...points },
      leaderAfter: lead > 0 ? "white" : lead < 0 ? "black" : "tie",
    });

    board += 1;
    boardShots = 0;
    boardCoins = { white: 0, black: 0 };
    boardFouls = { white: 0, black: 0 };
    boardQueenTaker = null;
    boardQueenCovered = false;
  };

  for (const event of events) {
    const payload = event.payload;

    switch (event.type) {
      case "match_start": {
        const seats = Array.isArray(payload["seats"]) ? payload["seats"] : [];
        for (const seat of seats) {
          if (typeof seat !== "object" || seat === null) {
            continue;
          }
          const record = seat as Record<string, unknown>;
          const colour = seatFor(record);
          if (colour === null) {
            continue;
          }
          identity[colour] = {
            playerId: typeof record["playerId"] === "string" ? record["playerId"] : "",
            displayName: typeof record["displayName"] === "string" ? record["displayName"] : colour,
            isBot: record["isBot"] === true,
          };
        }
        break;
      }
      case "shot": {
        const shooter = seatFor(payload);
        totalShots += 1;
        boardShots += 1;
        if (shooter !== null) {
          shots[shooter] += 1;
        }
        break;
      }
      case "coin_pocketed": {
        const creditedTo = colour(payload["creditedTo"], "white");
        const coin = colour(payload["coin"], creditedTo);
        if (creditedTo === coin) {
          coins[creditedTo] += 1;
          boardCoins[creditedTo] += 1;
        } else {
          opponentCoins[creditedTo] += 1;
        }
        if (firstCoin === null) {
          firstCoin = { player: creditedTo, coin };
        }
        break;
      }
      case "queen_pocketed": {
        const taker = colour(payload["by"], "white");
        boardQueenTaker = taker;
        queenTakes[taker] += 1;
        if (queen === null) {
          queen = {
            taker,
            board,
            covered: false,
            winsBoard: false,
            shot: num(payload["shot"]),
          };
        }
        break;
      }
      case "queen_covered": {
        const by = colour(payload["by"], "white");
        boardQueenCovered = true;
        queenCovers[by] += 1;
        const current = queen;
        if (current !== null && current.taker === by && !current.covered) {
          queen = markCovered(current);
        }
        break;
      }
      case "foul": {
        const by = colour(payload["by"], "white");
        fouls[by] += 1;
        boardFouls[by] += 1;
        if (payload["reason"] === "striker_pocketed") {
          strikerPockets[by] += 1;
          strikerPocketed = true;
        }
        if (firstFoul === null) {
          firstFoul = { player: by, board };
        }
        break;
      }
      case "board_ended": {
        flushBoard(payload);
        break;
      }
      case "match_ended": {
        const scores = payload["scores"];
        if (typeof scores === "object" && scores !== null) {
          const record = scores as Record<string, unknown>;
          points.white = num(record["white"]);
          points.black = num(record["black"]);
        }
        winner =
          payload["winner"] === "white" || payload["winner"] === "black"
            ? payload["winner"]
            : "tie";
        break;
      }
      default:
        break;
    }
  }

  const finalQueen = queen;
  if (finalQueen !== null) {
    const decided: BoardStats | undefined = boards.find(
      (entry) => entry.board === finalQueen.board,
    );
    queen = {
      ...finalQueen,
      winsBoard: decided !== undefined && decided.winner === finalQueen.taker,
    };
  }

  const startedAt = options.startedAt === undefined ? null : options.startedAt;
  const endedAt = options.endedAt === undefined ? null : options.endedAt;
  const elapsedMs =
    startedAt !== null && endedAt !== null ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
  const matchMinutes = Number.isFinite(elapsedMs)
    ? Math.max(0, elapsedMs) / 60_000
    : (totalShots * secondsPerShot) / 60;

  const player = (colour: Colour): PlayerStats => ({
    colour,
    ...identity[colour],
    points: points[colour],
    boardsWon: boardsWon[colour],
    coins: coins[colour],
    opponentCoins: opponentCoins[colour],
    fouls: fouls[colour],
    strikerPockets: strikerPockets[colour],
    shots: shots[colour],
    queenTakes: queenTakes[colour],
    queenCovers: queenCovers[colour],
    bestLead: bestLead[colour],
    everTrailed: everTrailed[colour],
  });

  return {
    matchId,
    players: { white: player("white"), black: player("black") },
    boards,
    boardsPlayed: boards.length,
    winner,
    totalPoints: points.white + points.black,
    totalFouls: fouls.white + fouls.black,
    totalShots,
    whitewashBoards,
    firstCoin,
    firstFoul,
    strikerPocketed,
    queen,
    matchMinutes,
    finished: winner !== null,
  };
}

/** True when the match got far enough that the market can be settled at all. */
export function boardOf(stats: MatchStats, board: number): BoardStats | null {
  return stats.boards.find((entry) => entry.board === board) ?? null;
}
