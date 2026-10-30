import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/engines/carrom/config.js";
import { commitOf } from "../../src/lib/fair-rng.js";
import { InMemoryMatchRepository } from "../../src/lib/match-repository.js";
import { CarromMatchRunner, runnerSeatsFromMatch } from "../../src/rooms/carrom-match-runner.js";
import { bucketCalibration, runBacktest, type BacktestSample } from "../../src/odds/backtest.js";

function samples(predicted: number, count: number, actual: boolean): BacktestSample[] {
  return Array.from({ length: count }, () => ({
    marketType: "match_winner",
    predicted,
    actual,
  }));
}

describe("the backtest", () => {
  it("puts every claim in the bucket its prediction belongs to", () => {
    const report = bucketCalibration([...samples(0.05, 100, false), ...samples(0.55, 100, true)]);

    expect(report.samples).toBe(200);
    expect(report.rows).toHaveLength(2);

    const low = report.rows.find((row) => row.bucket === 0);
    expect(low?.count).toBe(100);
    expect(low?.observed).toBe(0);

    const middle = report.rows.find((row) => row.bucket === 5);
    expect(middle?.count).toBe(100);
    expect(middle?.observed).toBe(1);
  });

  it("reports how far the observed rate is from the predicted one", () => {
    // Half of the 60% claims happened: a 10 point miss, which the report must
    // show rather than average away.
    const report = bucketCalibration([...samples(0.6, 50, true), ...samples(0.6, 50, false)]);

    const row = report.rows[0];
    expect(row?.predicted).toBeCloseTo(0.6, 6);
    expect(row?.observed).toBeCloseTo(0.5, 6);
    expect(row?.error).toBeCloseTo(0.1, 6);
    expect(report.worstError).toBeCloseTo(0.1, 6);
  });

  it("scores a perfect model at zero and a coin flip at its own error", () => {
    const perfect = bucketCalibration([
      ...samples(0.999, 100, true),
      ...samples(0.001, 100, false),
    ]);
    expect(perfect.brier).toBeLessThan(0.01);

    const coinFlip = bucketCalibration(samples(0.5, 100, true));
    expect(coinFlip.brier).toBeCloseTo(0.25, 6);
  });

  it("ignores buckets too small to say anything when judging the worst error", () => {
    // One wrong claim in a thin bucket is noise, not a numbers bug: the worst
    // error reported is the thick bucket's 0.2, not the single 0.9 miss.
    const report = bucketCalibration([...samples(0.9, 1, false), ...samples(0.2, 60, false)]);
    expect(report.worstError).toBeCloseTo(0.2, 2);
  });

  it("scores a match that really finished against the model's own predictions", async () => {
    const config = resolveConfig();
    const repository = new InMemoryMatchRepository();
    const seed = "backtest-seed";
    const match = await repository.create({
      seedCommit: commitOf(seed),
      config: { carrom: config },
      seats: [
        { seat: 1, botLevel: "club" },
        { seat: 2, botLevel: "rookie" },
      ],
    });

    let settled: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      settled = resolve;
    });

    const runner = new CarromMatchRunner({
      matchId: match.id,
      seed,
      seedCommit: commitOf(seed),
      seats: runnerSeatsFromMatch(match),
      repository,
      config,
      botDelayMs: { min: 0, max: 0 },
      hooks: {
        onEnd: () => {
          settled();
        },
      },
    });

    await runner.start();
    await finished;

    const played = await repository.get(match.id);
    expect(played).not.toBeNull();

    const events = await repository.listEvents(match.id);
    const record = played as NonNullable<typeof played>;

    const report = await runBacktest({
      simulations: 200,
      loadMatches: () => Promise.resolve([{ match: record, events }]),
    });

    expect(report.matches).toBe(1);
    expect(report.samples).toBeGreaterThan(0);
    expect(report.rows.length).toBeGreaterThan(0);
    for (const row of report.rows) {
      expect(row.predicted).toBeGreaterThanOrEqual(0);
      expect(row.predicted).toBeLessThanOrEqual(1);
      expect(row.observed).toBeGreaterThanOrEqual(0);
      expect(row.observed).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
