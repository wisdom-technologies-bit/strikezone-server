import { BOT_PROFILES, type BotLevel } from "../engines/carrom/bot-config.js";
import type { FixtureGame, FixturePlan, FixtureSeatPlan } from "./types.js";

/**
 * Who plays the house fixtures.
 *
 * Two rules shape this roster.
 *
 * 1. **Every seat is its own bot.** A bot is an identity keyed on its display
 *    name, so four Ludo seats must be four different names; one name in four
 *    seats is one player seated four times, which the database refuses and which
 *    would price as a match against itself.
 * 2. **Pairings rotate, so the prices differ.** A Carrom fixture pairs different
 *    skill tiers, and a Ludo fixture mixes the three policies; each fixture in
 *    turn moves them a seat along, so the same four bots do not line up the same
 *    way twice in a row.
 */

/** The Carrom pairings, in rotation. Levels differ, so the prices do. */
const CARROM_PAIRINGS: ReadonlyArray<readonly [BotLevel, BotLevel]> = [
  ["rookie", "club"],
  ["club", "master"],
  ["rookie", "master"],
];

/**
 * The four house Ludo bots.
 *
 * Names are deliberately not the Carrom ones: a bot's identity includes the name,
 * so reusing "Bot Club" for a Ludo seat would point at the Carrom player and its
 * Carrom policy. Each name carries one fixed policy, and the rotation below moves
 * the seats around rather than the policies between names.
 */
export const LUDO_HOUSE_BOTS: ReadonlyArray<{ name: string; policy: string }> = Object.freeze([
  { name: "House Cautious", policy: "cautious" },
  { name: "House Aggressive", policy: "aggressive" },
  { name: "House Racer", policy: "racer" },
  { name: "House Steady", policy: "cautious" },
]);

/** The Carrom bot display names come from the published profiles. */
function carromSeat(seat: 1 | 2, level: BotLevel): FixtureSeatPlan {
  return { seat, botLevel: level, displayName: BOT_PROFILES[level].displayName };
}

/** A Carrom fixture: two different skill tiers. */
export function carromFixture(index: number): FixturePlan {
  const pairing = CARROM_PAIRINGS[index % CARROM_PAIRINGS.length] ?? CARROM_PAIRINGS[0];
  const [left, right] = pairing ?? ["rookie", "club"];

  return {
    game: "carrom",
    seats: [carromSeat(1, left), carromSeat(2, right)],
    config: { carrom: { pointsToWinMatch: 2, boardsPerMatch: 3 }, turnSeconds: 30 },
  };
}

/** A Ludo fixture: the four house bots, rotated one seat per fixture. */
export function ludoFixture(index: number): FixturePlan {
  const rotated = LUDO_HOUSE_BOTS.map((_, offset, all) => all[(offset + index) % all.length]);

  return {
    game: "ludo",
    seats: rotated.map((bot, position) => ({
      seat: (position + 1) as 1 | 2 | 3 | 4,
      botLevel: "club" as BotLevel,
      botPolicy: bot?.policy ?? "cautious",
      displayName: bot?.name ?? "House Cautious",
    })),
    config: { ludo: { players: 4, moveSeconds: 20 } },
  };
}

/**
 * The plan for the fixture at `index`, alternating through the configured games.
 *
 * The index is the number of fixtures scheduled so far, so the game alternates by
 * the calendar rather than by which instance happens to tick.
 */
export function fixturePlanFor(games: readonly FixtureGame[], index: number): FixturePlan {
  const game = games[index % games.length] ?? "carrom";
  const round = Math.floor(index / games.length);
  return game === "ludo" ? ludoFixture(round) : carromFixture(round);
}
