import { createFastDice } from "../src/engines/ludo/dice.js";
import { LudoSimulator } from "../src/engines/ludo/sim.js";
import type { LudoBotId } from "../src/engines/ludo/bot-config.js";

/**
 * npm run ludo:bench
 *
 * The odds engine prices Ludo markets by playing millions of games, so the
 * simulator has to be fast enough that the price is not the bottleneck. This
 * measures exactly that: one thread, one million turns per policy, no I/O, no
 * allocation in the loop.
 *
 * It prints the measured rate and exits non zero when it misses the target of
 * 1,000,000 turns per second, so CI catches a regression rather than a person.
 */

const TARGET_TURNS_PER_SECOND = 1_000_000;
const TURNS = 4_000_000;
const POLICIES: readonly LudoBotId[] = ["cautious", "aggressive", "racer"];

interface Measurement {
  readonly policy: LudoBotId;
  readonly turns: number;
  readonly milliseconds: number;
  readonly games: number;
}

function measure(policy: LudoBotId): Measurement {
  const dice = createFastDice(`bench-${policy}-0123456789abcdef0123456789abcdef`, "bench");
  const simulator = new LudoSimulator({ policy });
  let games = 0;

  // Warm the JIT before the clock starts, so the number is the steady rate.
  for (let warm = 0; warm < 50_000; warm += 1) {
    if (simulator.status === "finished") {
      simulator.reset();
      games += 1;
    }
    simulator.playTurn(dice.roll(6));
  }

  games = 0;
  const started = process.hrtime.bigint();
  for (let turn = 0; turn < TURNS; turn += 1) {
    if (simulator.status === "finished") {
      simulator.reset();
      games += 1;
    }
    simulator.playTurn(dice.roll(6));
  }
  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;

  return { policy, turns: TURNS, milliseconds, games };
}

function main(): number {
  console.log(`Ludo simulator benchmark: ${TURNS.toLocaleString("en-GB")} turns per policy, one thread`);

  let slowest = Number.POSITIVE_INFINITY;

  for (const policy of POLICIES) {
    const measurement = measure(policy);
    const perSecond = measurement.turns / (measurement.milliseconds / 1000);
    slowest = Math.min(slowest, perSecond);

    console.log(
      `  ${policy.padEnd(11)} ${Math.round(perSecond).toLocaleString("en-GB")} turns/s ` +
        `(${measurement.milliseconds.toFixed(0)} ms for ${measurement.turns.toLocaleString("en-GB")} turns)`,
    );
  }

  const formatted = Math.round(slowest).toLocaleString("en-GB");
  console.log(`\n  measured: ${formatted} turns/s on the slowest policy`);
  console.log(`  target:   ${TARGET_TURNS_PER_SECOND.toLocaleString("en-GB")} turns/s`);

  if (slowest < TARGET_TURNS_PER_SECOND) {
    console.log("  FAIL: the simulator is slower than the odds engine needs");
    return 1;
  }

  console.log("  PASS: the simulator clears the target with room to spare");
  return 0;
}

process.exitCode = main();
