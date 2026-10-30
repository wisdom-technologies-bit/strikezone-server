/**
 * The Ludo engine.
 *
 * Pure rules code: no network, no database, no betting. Randomness arrives as a
 * {@link DieSource} or a uniform generator, so a game is reproducible from the
 * seed in src/lib/fair-rng.ts and nothing here can call Math.random.
 */

export {
  DEFAULT_LUDO_CONFIG,
  LUDO_GEOMETRY,
  isSafeCell,
  resolveLudoConfig,
  ringCellOf,
  seatsOf,
  startCellOf,
  type LudoConfig,
  type LudoGeometry,
} from "./config.js";
export {
  LUDO_HOME,
  LUDO_YARD,
  type LudoChooser,
  type LudoEvent,
  type LudoEventType,
  type LudoMove,
  type LudoMoveKind,
  type LudoOutcome,
  type LudoState,
} from "./types.js";
export {
  applyMove,
  applyRoll,
  createInitialState,
  forfeitTurn,
  getLegalMoves,
  homeCount,
  isLegalMove,
  isPlayerFinished,
  passTurn,
  progressOf,
  remainingTokens,
  rollDie,
  seatToPlay,
  shouldForfeitTripleSix,
  tokenIndex,
} from "./rules.js";
export { createFastDice, createMatchDice, type DieSource } from "./dice.js";
export {
  aggressiveChooser,
  cautiousChooser,
  chooserFor,
  isCellDangerous,
  racerChooser,
} from "./bots.js";
export { LUDO_BOT_IDS, LUDO_BOT_POLICIES, ludoBot, type LudoBotId, type LudoBotPolicy } from "./bot-config.js";
