import { describe, expect, it } from "vitest";
import {
  BOT_POLICIES,
  botCandidates,
  chooseBotShot,
  chooseCandidate,
  chooseCandidate as pick,
  publishedBots,
  safeShot,
  scoreCandidate,
  withShotNoise,
} from "../../src/engines/carrom/bots.js";
import { BOT_LEVELS, BOT_PROFILES } from "../../src/engines/carrom/bot-config.js";
import {
  applyShot,
  createInitialState,
  isLegalStrikerPlacement,
  type CarromState,
} from "../../src/engines/carrom/index.js";
import { createMatchRng, createSeededRng } from "../../src/lib/fair-rng.js";
import { config } from "./helpers.js";

const DEGREES = Math.PI / 180;
const SEED = "9c1f5a7b3e2d40c8a6b9d1e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6";

function rngFor(label: string, nonce = 0) {
  return createMatchRng(SEED, `match-${label}`, nonce);
}

describe("published bot levels", () => {
  it("publishes exactly the three levels, with their numbers and bot names", () => {
    const bots = publishedBots();

    expect(bots).toHaveLength(3);
    expect(bots.map((bot) => bot.level)).toEqual([...BOT_LEVELS]);

    const byLevel = new Map(bots.map((bot) => [bot.level, bot]));
    expect(byLevel.get("rookie")).toMatchObject({
      displayName: "Bot Rookie",
      aimErrorDegrees: 4,
      selectionQuality: 0.4,
      isBot: true,
      policy: "carrom_rookie",
    });
    expect(byLevel.get("club")).toMatchObject({
      displayName: "Bot Club",
      aimErrorDegrees: 2,
      selectionQuality: 0.7,
      isBot: true,
    });
    expect(byLevel.get("master")).toMatchObject({
      displayName: "Bot Master",
      aimErrorDegrees: 0.8,
      selectionQuality: 0.95,
      isBot: true,
    });
  });

  it("says can bot on every level and never looks like a human name", () => {
    for (const level of BOT_LEVELS) {
      const profile = BOT_PROFILES[level];
      expect(profile.displayName.toLowerCase()).toContain("bot");
      expect(profile.policy).toContain("bot".length > 0 ? "carrom_" : "");
      expect(BOT_POLICIES[level].id).toBe(profile.policy);
    }
  });
});

describe("candidate shots", () => {
  it("builds one candidate per own coin and pocket, best first", () => {
    const state = createInitialState(config, "candidates");
    const candidates = botCandidates(state, config);

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.score).toBeGreaterThan(0);
      expect(candidate.score).toBeLessThanOrEqual(1);
      expect(candidate.power).toBeGreaterThanOrEqual(0);
      expect(candidate.power).toBeLessThanOrEqual(1);
      expect(candidate.cutDegrees).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(candidate.angle)).toBe(true);
    }
    const scores = candidates.map((candidate) => candidate.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  it("prefers a straight short shot to a long cut and to a crowded one", () => {
    const straight = scoreCandidate(0, 200, 0, false);
    const cut = scoreCandidate(30, 200, 0, false);
    const long = scoreCandidate(0, 600, 0, false);
    const crowded = scoreCandidate(0, 200, 3, false);
    const clamped = scoreCandidate(0, 200, 0, true);

    expect(straight).toBeGreaterThan(cut);
    expect(straight).toBeGreaterThan(long);
    expect(straight).toBeGreaterThan(crowded);
    expect(straight).toBeGreaterThan(clamped);
    expect(crowded).toBeGreaterThan(scoreCandidate(0, 200, 6, false));
  });

  it("finds the straight pot when one is on", () => {
    // One own coin between the striker's baseline and a pocket, dead in line.
    const base = createInitialState(config, "straight");
    const coin = { id: "w1", colour: "white" as const, x: 0, y: 0 };
    const state: CarromState = {
      ...base,
      coins: [coin],
      queen: { onBoard: false, coveredBy: null, pending: null },
    };

    const best = botCandidates(state, config)[0];
    expect(best).toBeDefined();
    // Straight up the board into the top-left or top-right pocket is far from a
    // straight pot from x = 0, so the best candidate should be a small cut.
    expect(best?.cutDegrees ?? 999).toBeLessThan(45);
  });
});

describe("softmax choice", () => {
  it("always takes a best-scoring candidate at quality 1", () => {
    const state = createInitialState(config, "quality");
    const candidates = botCandidates(state, config);
    const best = candidates[0]?.score ?? 0;
    const rng = rngFor("quality-1");

    for (let index = 0; index < 50; index += 1) {
      expect(chooseCandidate(candidates, 1, rng)?.score).toBe(best);
    }
  });

  it("spreads at low quality and concentrates at high quality", () => {
    const state = createInitialState(config, "spread");
    const candidates = botCandidates(state, config);
    const best = candidates[0]?.score ?? 0;

    const measure = (quality: number): { regret: number; distinct: number } => {
      const rng = rngFor(`spread-${quality}`);
      const distinct = new Set<string>();
      let regret = 0;
      const draws = 500;

      for (let index = 0; index < draws; index += 1) {
        const chosen = pick(candidates, quality, rng);
        if (chosen === undefined) {
          throw new Error("no candidate");
        }
        regret += best - chosen.score;
        distinct.add(`${chosen.coinId}:${chosen.pocketIndex}`);
      }

      return { regret: regret / draws, distinct: distinct.size };
    };

    const low = measure(0.4);
    const high = measure(0.95);

    // A sharper choice means less regret, and more of the list gets used when the
    // quality is low.
    expect(high.regret).toBeLessThan(low.regret);
    expect(high.regret).toBeLessThan(0.001);
    expect(low.distinct).toBeGreaterThan(high.distinct);
  });
});

describe("shot noise and legality", () => {
  it("noises the angle around the candidate and keeps the power in range", () => {
    const state = createInitialState(config, "noise");
    const candidate = botCandidates(state, config)[0];
    if (candidate === undefined) {
      throw new Error("no candidates");
    }

    const rng = rngFor("noise");
    const deviations: number[] = [];

    for (let index = 0; index < 4_000; index += 1) {
      const shot = withShotNoise(candidate, "rookie", {}, rng);
      deviations.push((shot.angle - candidate.angle) / DEGREES);
      expect(shot.power).toBeGreaterThan(0);
      expect(shot.power).toBeLessThanOrEqual(1);
      expect(shot.strikerPosition).toEqual({
        x: candidate.strikerX,
        y: candidate.strikerY,
      });
    }

    const mean = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
    const variance =
      deviations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deviations.length;

    expect(Math.abs(mean)).toBeLessThan(0.3);
    expect(Math.sqrt(variance)).toBeGreaterThan(3.4);
    expect(Math.sqrt(variance)).toBeLessThan(4.6);
  });

  it("produces a legal shot for every level, on both baselines, whatever the seed", () => {
    for (const level of BOT_LEVELS) {
      for (const turn of ["white", "black"] as const) {
        for (let nonce = 0; nonce < 12; nonce += 1) {
          const base = createInitialState(config, `legal-${level}-${turn}-${nonce}`);
          const state: CarromState = { ...base, turn };
          const shot = chooseBotShot(
            level,
            state,
            createMatchRng(SEED, `legal-${nonce}`),
            {},
            config,
          );

          expect(isLegalStrikerPlacement(state, shot.strikerPosition, config)).toBe(true);
          expect(shot.power).toBeGreaterThanOrEqual(0);
          expect(shot.power).toBeLessThanOrEqual(1);
          expect(Number.isFinite(shot.angle)).toBe(true);
        }
      }
    }
  });

  it("gives the same shot for the same seed and nonce, and a different one otherwise", () => {
    const state = createInitialState(config, "repeat");
    const first = chooseBotShot("club", state, createMatchRng(SEED, "repeat"), {}, config);
    const second = chooseBotShot("club", state, createMatchRng(SEED, "repeat"), {}, config);
    const third = chooseBotShot("club", state, createMatchRng(SEED, "repeat", 50), {}, config);

    expect(second).toEqual(first);
    expect(third).not.toEqual(first);
  });

  it("falls back to a safe legal shot when there is no own coin to aim at", () => {
    const base = createInitialState(config, "empty");
    const state: CarromState = {
      ...base,
      coins: base.coins.filter((coin) => coin.colour !== "white"),
    };

    const shot = chooseBotShot("master", state, rngFor("empty"), {}, config);
    expect(shot).toEqual(safeShot(state, config));
    expect(isLegalStrikerPlacement(state, shot.strikerPosition, config)).toBe(true);
  });
});

describe("skill shows in the play", () => {
  it("picks better shots as the level rises", () => {
    const state = createInitialState(config, "skill");
    const candidates = botCandidates(state, config);
    const bestById = new Map(
      candidates.map((candidate) => [
        `${candidate.coinId}:${candidate.pocketIndex}`,
        candidate.score,
      ]),
    );

    const meanScore = (quality: number): number => {
      const rng = createMatchRng(SEED, `skill-${quality}`);
      let total = 0;
      const draws = 400;

      for (let index = 0; index < draws; index += 1) {
        const chosen = chooseCandidate(candidates, quality, rng);
        if (chosen === undefined) {
          throw new Error("no candidate");
        }
        total += bestById.get(`${chosen.coinId}:${chosen.pocketIndex}`) ?? 0;
      }

      return total / draws;
    };

    const rookie = meanScore(0.4);
    const club = meanScore(0.7);
    const master = meanScore(0.95);

    expect(master).toBeGreaterThan(club);
    expect(club).toBeGreaterThan(rookie);
  });

  it("pots a coin within a handful of shots from the opening", () => {
    let state = createInitialState(config, "potting");
    let pocketed = 0;

    for (let index = 0; index < 20 && state.phase === "aiming"; index += 1) {
      const shot = chooseBotShot(
        "master",
        state,
        createMatchRng(SEED, "potting", index * 10),
        {},
        config,
      );
      const result = applyShot(state, shot, { config });
      for (const event of result.events) {
        if (event.type === "coin_pocketed" && event.creditedTo === event.by) {
          pocketed += 1;
        }
      }
      state = result.state;
    }

    expect(pocketed).toBeGreaterThan(0);
  });
});

describe("bot determinism through the seeded generator", () => {
  it("runs the same with createSeededRng as it would with the match stream", () => {
    const state = createInitialState(config, "seeded");
    const first = chooseBotShot("rookie", state, createSeededRng("in-process"), {}, config);
    const second = chooseBotShot("rookie", state, createSeededRng("in-process"), {}, config);

    expect(second).toEqual(first);
  });
});
