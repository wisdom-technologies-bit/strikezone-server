import { describe, expect, it } from "vitest";
import {
  applyRoll,
  chooserFor,
  createFastDice,
  createInitialState,
  LUDO_BOT_POLICIES,
  ludoBot,
  type LudoBotId,
} from "../../../src/engines/ludo/index.js";
import { LudoSimulator } from "../../../src/engines/ludo/sim.js";

/**
 * The simulator against the referee, and the game against the arithmetic.
 *
 * `src/engines/ludo/sim.ts` is a second implementation of the same rules, written
 * for speed. Two implementations of one rule set is a risk, so the first test here
 * plays whole games with both, on the same rolls, and compares them turn by turn:
 * any divergence fails, which is what keeps the fast path honest.
 */

const POLICIES: readonly LudoBotId[] = ["cautious", "aggressive", "racer"];

function playBoth(policy: LudoBotId, seed: string): { turns: number } {
  const refereeDice = createFastDice(seed, "parity");
  const simulatorDice = createFastDice(seed, "parity");
  const chooser = chooserFor(policy);
  const simulator = new LudoSimulator({ policy });

  let state = createInitialState({ players: 4 });
  let turns = 0;

  while (state.status === "playing" && turns < 10_000) {
    const refereeRoll = refereeDice.roll(6);
    const simulatorRoll = simulatorDice.roll(6);
    expect(simulatorRoll).toBe(refereeRoll);

    state = applyRoll(state, refereeRoll, chooser).state;
    simulator.playTurn(simulatorRoll);
    turns += 1;

    const snapshot = simulator.snapshot();
    expect(snapshot.tokens).toEqual([...state.tokens]);
    expect(snapshot.turn).toBe(state.turn);
    expect(snapshot.sixes).toBe(state.sixes);
    expect(snapshot.rolls).toBe(state.rolls);
    expect(snapshot.status).toBe(state.status);
  }

  return { turns };
}

describe("the simulator matches the referee", () => {
  for (const policy of POLICIES) {
    it(`plays identical games under the ${policy} policy`, () => {
      for (let game = 0; game < 25; game += 1) {
        const { turns } = playBoth(policy, `parity-${policy}-${String(game)}-0123456789abcdef`);
        expect(turns).toBeGreaterThan(50);
        expect(turns).toBeLessThan(10_000);
      }
    }, 30_000);
  }

  it("builds the same opening state as the referee", () => {
    const simulator = new LudoSimulator({ policy: "cautious" });
    expect(simulator.snapshot()).toEqual(createInitialState({ players: 4 }));
  });
});

describe("the shape of a game", () => {
  it("always ends, with every place filled", () => {
    const dice = createFastDice("d".repeat(64), "shape");
    const simulator = new LudoSimulator({ policy: "racer" });

    for (let game = 0; game < 200; game += 1) {
      simulator.reset();
      let turns = 0;
      while (simulator.status === "playing" && turns < 10_000) {
        simulator.playTurn(dice.roll(6));
        turns += 1;
      }
      expect(simulator.status).toBe("finished");
      expect(simulator.finishingOrder()).toEqual([0, 1, 2, 3].sort((left, right) => {
        const order = simulator.finishingOrder();
        return order.indexOf(left) - order.indexOf(right);
      }));
      expect([...simulator.finishingOrder()].sort()).toEqual([0, 1, 2, 3]);
    }
  }, 30_000);
});

describe("four identical bots", () => {
  it("each wins about a quarter of the games, with the first seat slightly ahead", () => {
    const games = 2_000;
    const dice = createFastDice("e".repeat(64), "seat-fairness");
    const simulator = new LudoSimulator({ policy: "cautious" });
    const wins = [0, 0, 0, 0];

    for (let game = 0; game < games; game += 1) {
      simulator.reset();
      while (simulator.status === "playing") {
        simulator.playTurn(dice.roll(6));
      }
      const winner = simulator.finishingOrder()[0] ?? -1;
      if (winner >= 0) {
        wins[winner] = (wins[winner] ?? 0) + 1;
      }
    }

    const shares = wins.map((count) => count / games);
    for (const share of shares) {
      // Around a quarter. The band is wide because moving first is worth a couple
      // of points: measured over these two thousand games the four seats sit at
      // roughly 27, 26, 24 and 22 per cent, in seat order.
      expect(share).toBeGreaterThan(0.2);
      expect(share).toBeLessThan(0.3);
    }

    // The advantage the brief asks about: the first seat is ahead of the last.
    expect(shares[0] ?? 0).toBeGreaterThan(shares[3] ?? 0);
  }, 60_000);
});

describe("the published policies", () => {
  it("are three, all labelled as bots, named Bot Something", () => {
    expect(LUDO_BOT_POLICIES).toHaveLength(3);
    for (const policy of LUDO_BOT_POLICIES) {
      expect(policy.isBot).toBe(true);
      expect(policy.name.startsWith("Bot ")).toBe(true);
      expect(ludoBot(policy.id)).toEqual(policy);
    }

    expect(LUDO_BOT_POLICIES.map((policy) => policy.name)).toEqual([
      "Bot Cautious",
      "Bot Aggressive",
      "Bot Racer",
    ]);
  });

  it("has no policy for an id that does not exist", () => {
    expect(ludoBot("cheating")).toBeNull();
  });
});
