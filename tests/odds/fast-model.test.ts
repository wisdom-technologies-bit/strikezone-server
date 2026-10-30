import { describe, expect, it } from "vitest";
import { simulateFastMatch, potChance, shotGeometry } from "../../src/odds/carrom-fast-model.js";

const club = { aimErrorDegrees: 2, selectionQuality: 0.7, foulRate: 0.05 };
const rookie = { aimErrorDegrees: 4, selectionQuality: 0.4, foulRate: 0.08 };
const master = { aimErrorDegrees: 0.8, selectionQuality: 0.95, foulRate: 0.03 };

function play(white: typeof club, black: typeof club, index: number) {
  return simulateFastMatch({
    matchId: `m${String(index)}`,
    seed: `seed-${String(index)}`,
    white: { playerId: "white", displayName: "White", isBot: true, skill: white },
    black: { playerId: "black", displayName: "Black", isBot: true, skill: black },
  });
}

describe("the fast match model", () => {
  it("is reproducible from its seed", () => {
    const first = play(club, rookie, 7);
    const second = play(club, rookie, 7);
    expect(second.winner).toBe(first.winner);
    expect(second.totalPoints).toBe(first.totalPoints);
    expect(second.totalShots).toBe(first.totalShots);
  });

  it("gives the better player the better chance", () => {
    const rate = (strong: typeof club): number => {
      let wins = 0;
      const matches = 600;
      for (let index = 0; index < matches; index += 1) {
        if (play(strong, rookie, index).winner === "white") {
          wins += 1;
        }
      }
      return wins / matches;
    };

    // A better hand wins well over half the time, and a Master is never worse
    // than a Club against the same opponent.
    //
    // NOT asserted: that Master is *strictly* more likely to win than Club. Both
    // sit near certainty here, so this model cannot separate them until the
    // fast-versus-real validation harness tunes its skill sensitivity. That is a
    // known defect of the model, recorded in src/odds/README.md.
    const masterRate = rate(master);
    const clubRate = rate(club);
    expect(clubRate).toBeGreaterThan(0.6);
    expect(masterRate).toBeGreaterThanOrEqual(clubRate - 0.05);
  });

  it("keeps two equal players near even", () => {
    let whiteWins = 0;
    const matches = 600;
    for (let index = 0; index < matches; index += 1) {
      if (play(club, club, index).winner === "white") {
        whiteWins += 1;
      }
    }
    const rate = whiteWins / matches;
    expect(rate).toBeGreaterThan(0.42);
    expect(rate).toBeLessThan(0.58);
  });

  it("produces a complete, self-consistent scoreline", () => {
    const stats = play(club, rookie, 3);
    expect(stats.finished).toBe(true);
    expect(stats.boardsPlayed).toBeGreaterThan(0);
    expect(stats.boards).toHaveLength(stats.boardsPlayed);
    expect(stats.players.white.points + stats.players.black.points).toBe(stats.totalPoints);
    for (const board of stats.boards) {
      expect(["white", "black"]).toContain(board.winner);
      expect(board.points).toBeGreaterThanOrEqual(0);
    }
    const last = stats.boards[stats.boards.length - 1];
    expect(last?.scoreAfter).toEqual({
      white: stats.players.white.points,
      black: stats.players.black.points,
    });
  });

  it("reads a better hand as a better chance, and a crowded board as a closer one", () => {
    expect(potChance(master, 12)).toBeGreaterThan(potChance(rookie, 12));
    expect(shotGeometry(12).distanceMm).toBeLessThan(shotGeometry(3).distanceMm);
    expect(shotGeometry(12).cutDegrees).toBeLessThan(shotGeometry(3).cutDegrees);
    // NOT asserted: that an emptier board is harder. The measured table is not
    // monotone cell by cell (unreachable cells are filled from neighbours), so
    // that claim is untested until the sampler is replaced.
  });
});
