import {
  createInitialState,
  resolveConfig,
  type CarromCoin,
  type CarromColour,
  type CarromQueenState,
  type CarromState,
  type CoinColour,
} from "../../src/engines/carrom/index.js";
import type { PocketedBody, ShotOutcome } from "../../src/engines/carrom/physics.js";

/** Board and match settings used by the tests. */
export const config = resolveConfig({ boardsPerMatch: 8 });

/** The standard opening formation, used as a source of coin ids and positions. */
export const layout: readonly CarromCoin[] = createInitialState(config, "layout-seed").coins;

export interface RulesStateOptions {
  readonly turn?: CarromColour;
  readonly board?: number;
  readonly shot?: number;
  readonly pocketed?: Partial<Record<CarromColour, number>>;
  readonly owed?: Partial<Record<CarromColour, number>>;
  readonly scores?: Partial<Record<CarromColour, number>>;
  readonly queen?: Partial<CarromQueenState>;
  /** Coin ids still on the board. Defaults to the whole formation. */
  readonly coinIds?: readonly string[];
}

/** Builds a state for a rules test without running any physics. */
export function rulesState(options: RulesStateOptions = {}): CarromState {
  const base = createInitialState(config, "rules-seed");
  const ids = options.coinIds;
  const coins = ids === undefined ? [...layout] : layout.filter((coin) => ids.includes(coin.id));

  return {
    ...base,
    board: options.board ?? 1,
    shot: options.shot ?? 0,
    turn: options.turn ?? "white",
    coins,
    queen: { onBoard: true, coveredBy: null, pending: null, ...options.queen },
    players: {
      white: {
        score: options.scores?.white ?? 0,
        pocketed: options.pocketed?.white ?? 0,
        owed: options.owed?.white ?? 0,
      },
      black: {
        score: options.scores?.black ?? 0,
        pocketed: options.pocketed?.black ?? 0,
        owed: options.owed?.black ?? 0,
      },
    },
  };
}

export interface Drop {
  readonly id: string;
  readonly colour: CoinColour;
}

export interface OutcomeOptions {
  readonly strikerPocketed?: boolean;
}

/** A physics outcome where exactly these pieces dropped into pockets. */
export function outcomeFor(
  state: CarromState,
  drops: readonly Drop[],
  options: OutcomeOptions = {},
): ShotOutcome {
  const dropped = new Set(drops.map((drop) => drop.id));
  const coins = state.coins.filter((coin) => !dropped.has(coin.id));
  const pocketed: PocketedBody[] = drops.map((drop) => ({
    id: drop.id,
    kind: "coin",
    colour: drop.colour,
  }));

  if (options.strikerPocketed === true) {
    pocketed.push({ id: "striker", kind: "striker", colour: null });
  }

  return {
    coins,
    striker: options.strikerPocketed === true ? null : { x: 0, y: -280 },
    pocketed,
    frames: null,
  };
}

/** Ids of the coins still on the board. */
export function coinIds(state: CarromState): string[] {
  return state.coins.map((coin) => coin.id);
}

/** True when a colour has a coin on the board. */
export function hasCoin(state: CarromState, colour: CoinColour): boolean {
  return state.coins.some((coin) => coin.colour === colour);
}
