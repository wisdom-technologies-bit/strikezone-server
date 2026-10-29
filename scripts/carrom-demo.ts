/**
 * Carrom demo: plays a board (and the match, if it runs that long) with random
 * legal shots and prints what happens.
 *
 *   npm run carrom:demo
 *   npm run carrom:demo -- --seed my-seed --max-shots 400
 *
 * Shots are chosen with the seeded generator from src/lib/fair-rng.ts, so a run
 * is reproducible from its seed. This is a demonstration harness, not a bot: it
 * aims at a random coin and picks a random power, which is exactly the "random
 * legal shot" the engine is meant to survive.
 */
import {
  applyShot,
  colourForPlayer,
  createInitialState,
  findLegalStrikerX,
  getLegalStrikerRange,
  playerForTurn,
  resolveConfig,
  type CarromEvent,
  type CarromShot,
  type CarromState,
} from "../src/engines/carrom/index.js";
import { createSeededRng } from "../src/lib/fair-rng.js";
import type { SeededRng } from "../src/lib/fair-rng.js";

const args = process.argv.slice(2);

function readOption(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  return value === undefined ? fallback : value;
}

const seed = readOption("seed", "demo-seed");
const maxShots = Number(readOption("max-shots", "600"));
const config = resolveConfig({ boardsPerMatch: 8 });

/** Aims at one of the shooter's own coins, from a legal striker position. */
function chooseRandomLegalShot(state: CarromState, rng: SeededRng): CarromShot | null {
  const range = getLegalStrikerRange(state, config);
  const own = state.coins.filter((coin) => coin.colour === state.turn);
  const targets = own.length > 0 ? own : state.coins.filter((coin) => coin.colour === "queen");
  if (targets.length === 0) {
    return null;
  }

  const target = rng.pick(targets);
  const preferredX = target.x;
  const strikerX = findLegalStrikerX(state, preferredX, config);
  if (strikerX === null) {
    return null;
  }

  const ranged = range.maxX - range.minX;
  const jitterX = strikerX + (rng.nextFloat() - 0.5) * ranged * 0.12;
  const placed = findLegalStrikerX(
    state,
    Math.min(range.maxX, Math.max(range.minX, jitterX)),
    config,
  );
  if (placed === null) {
    return null;
  }

  const from = { x: placed, y: range.y };
  const angle = Math.atan2(target.y - from.y, target.x - from.x);
  const power = 0.45 + rng.nextFloat() * 0.5;

  return { strikerPosition: from, angle, power };
}

function describe(event: CarromEvent): string {
  switch (event.type) {
    case "coin_pocketed":
      return `pocket ${event.coinId} (${event.coin}${event.creditedTo === event.by ? "" : ` for ${event.creditedTo}`})`;
    case "queen_pocketed":
      return "queen pocketed";
    case "queen_covered":
      return "queen covered (+3)";
    case "queen_returned":
      return `queen returned (${event.reason})`;
    case "foul":
      return `FOUL ${event.reason}`;
    case "turn_changed":
      return `turn -> ${event.to}`;
    case "board_ended":
      return `board ${event.winner} wins +${event.points} (${event.opponentCoinsLeft} coins + ${event.queenPoints} queen)`;
    case "match_ended":
      return `match over: ${event.winner} (${event.scores.white}-${event.scores.black})`;
    default:
      return "?";
  }
}

function play(): void {
  const rng = createSeededRng(seed);
  let state = createInitialState(config, seed);
  let played = 0;
  let unplayable = 0;

  console.log(
    `carrom demo: seed=${seed} board=${state.board} turn=${state.turn} coins=${state.coins.length}`,
  );

  while (state.phase !== "match_ended" && played < maxShots) {
    const shot = chooseRandomLegalShot(state, rng);
    if (shot === null) {
      unplayable += 1;
      if (unplayable > 3) {
        console.log("no legal shot available, stopping");
        break;
      }
      continue;
    }

    const result = applyShot(state, shot, { config, recordFrames: false });
    played += 1;

    const summary = result.events.map(describe).join("; ");
    console.log(
      `#${String(played).padStart(3)} p${playerForTurn(state)} ${colourForPlayer(playerForTurn(state)).padEnd(5)} ` +
        `x=${shot.strikerPosition.x.toFixed(0)} angle=${((shot.angle * 180) / Math.PI).toFixed(0)}deg ` +
        `power=${shot.power.toFixed(2)} -> ${summary === "" ? "nothing" : summary}`,
    );

    state = result.state;
  }

  const white = state.players.white;
  const black = state.players.black;
  console.log("");
  console.log(
    `shots=${played} boards=${state.board} phase=${state.phase} score white=${white.score} black=${black.score}`,
  );

  if (state.phase === "match_ended") {
    const winner =
      white.score === black.score ? "tie" : white.score > black.score ? "white" : "black";
    console.log(`result: ${winner}`);
  } else {
    console.log(`stopped after ${played} shots without the match ending`);
  }
}

play();
