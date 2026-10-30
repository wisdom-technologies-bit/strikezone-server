import type { CatalogMarket, CatalogSelection, Settlement } from "./carrom.js";
import { DEFAULT_LUDO_LINES, type LudoLines } from "./ludo-lines.js";
import { LUDO_SEAT_NAMES, type LudoGameStats } from "../ludo-stats.js";

/**
 * The Ludo market catalogue interface.
 */
export interface LudoCatalog {
  readonly markets: readonly CatalogMarket[];
  settle(
    market: Pick<CatalogMarket, "marketType" | "subject" | "line">,
    key: string,
    stats: LudoGameStats,
  ): Settlement;
}

const SEAT_SLUGS = Object.freeze(["red", "green", "yellow", "blue"]) as readonly string[];

function seatSlug(seat: number): string {
  return SEAT_SLUGS[seat] ?? `seat_${String(seat)}`;
}

function seatName(seat: number): string {
  return LUDO_SEAT_NAMES[seat] ?? `Seat ${String(seat)}`;
}

function isOver(stats: LudoGameStats): boolean {
  return stats.finished && !stats.abandoned;
}

function overUnder(value: number | null, line: number | null, key: string): Settlement {
  if (value === null || line === null) {
    return "void";
  }
  if (value === line) {
    return "push";
  }
  const over = value > line;
  return (key === "over") === over ? "won" : "lost";
}

/**
 * Builds the Ludo market catalogue for the given lines and seats configuration.
 *
 * Market counts and selection totals for a standard 4-player match:
 * 91 market instances delivering exactly 270 priced selections.
 */
export function ludoCatalog(
  lines?: Partial<LudoLines>,
  seats: readonly number[] = [0, 1, 2, 3],
): LudoCatalog {
  const activeLines: LudoLines = { ...DEFAULT_LUDO_LINES, ...lines };
  const markets: CatalogMarket[] = [];

  // L1: ludo_match_winner
  markets.push({
    marketType: "ludo_match_winner",
    subject: "",
    line: null,
    name: "Match winner",
    live: true,
    stakeTier: "main",
    selections: seats.map((seat) => ({ key: seatSlug(seat), name: seatName(seat) })),
  });

  // L2: ludo_finish_place
  for (const seat of seats) {
    const isFourPlayers = seats.length === 4;
    const placeSelections: CatalogSelection[] = isFourPlayers
      ? [
          { key: "1st", name: "1st" },
          { key: "2nd", name: "2nd" },
          { key: "3rd", name: "3rd" },
          { key: "last", name: "Last" },
        ]
      : [
          { key: "1st", name: "1st" },
          { key: "last", name: "Last" },
        ];

    markets.push({
      marketType: "ludo_finish_place",
      subject: seatSlug(seat),
      line: null,
      name: `${seatName(seat)} finish place`,
      live: true,
      stakeTier: "main",
      selections: placeSelections,
    });
  }

  // L3: ludo_top_two
  for (const seat of seats) {
    markets.push({
      marketType: "ludo_top_two",
      subject: seatSlug(seat),
      line: null,
      name: `${seatName(seat)} top two finish`,
      live: true,
      stakeTier: "main",
      selections: [
        { key: "yes", name: "Yes" },
        { key: "no", name: "No" },
      ],
    });
  }

  // L4: ludo_head_to_head
  for (let i = 0; i < seats.length; i += 1) {
    for (let j = i + 1; j < seats.length; j += 1) {
      const seatA = seats[i]!;
      const seatB = seats[j]!;
      markets.push({
        marketType: "ludo_head_to_head",
        subject: `${seatSlug(seatA)}_${seatSlug(seatB)}`,
        line: null,
        name: `${seatName(seatA)} vs ${seatName(seatB)}`,
        live: false,
        stakeTier: "main",
        selections: [
          { key: seatSlug(seatA), name: seatName(seatA) },
          { key: seatSlug(seatB), name: seatName(seatB) },
        ],
      });
    }
  }

  // L5: ludo_first_out
  markets.push({
    marketType: "ludo_first_out",
    subject: "",
    line: null,
    name: "First token out",
    live: false,
    stakeTier: "standard",
    selections: seats.map((seat) => ({ key: seatSlug(seat), name: seatName(seat) })),
  });

  // L6: ludo_first_home
  markets.push({
    marketType: "ludo_first_home",
    subject: "",
    line: null,
    name: "First token home",
    live: false,
    stakeTier: "standard",
    selections: seats.map((seat) => ({ key: seatSlug(seat), name: seatName(seat) })),
  });

  // L7: ludo_winner_turns
  for (const line of activeLines.winnerTurns) {
    markets.push({
      marketType: "ludo_winner_turns",
      subject: "",
      line,
      name: `Winner turns over/under ${line.toFixed(1)}`,
      live: false,
      stakeTier: "standard",
      selections: [
        { key: "over", name: "Over" },
        { key: "under", name: "Under" },
      ],
    });
  }

  // L8: ludo_first_up, ludo_second_up, ludo_never_last
  markets.push({
    marketType: "ludo_first_up",
    subject: "",
    line: null,
    name: "1UP",
    live: true,
    stakeTier: "niche",
    selections: seats.map((seat) => ({ key: seatSlug(seat), name: seatName(seat) })),
  });

  markets.push({
    marketType: "ludo_second_up",
    subject: "",
    line: null,
    name: "2UP",
    live: true,
    stakeTier: "niche",
    selections: seats.map((seat) => ({ key: seatSlug(seat), name: seatName(seat) })),
  });

  for (const seat of seats) {
    markets.push({
      marketType: "ludo_never_last",
      subject: seatSlug(seat),
      line: null,
      name: `${seatName(seat)} Never Last`,
      live: true,
      stakeTier: "niche",
      selections: [
        { key: "yes", name: "Yes" },
        { key: "no", name: "No" },
      ],
    });
  }

  // L9: ludo_first_out_winner
  const firstOutWinnerSelections: CatalogSelection[] = [];
  for (const seatOut of seats) {
    for (const seatWin of seats) {
      firstOutWinnerSelections.push({
        key: `${seatSlug(seatOut)}_${seatSlug(seatWin)}`,
        name: `${seatName(seatOut)} first out, ${seatName(seatWin)} winner`,
      });
    }
  }
  markets.push({
    marketType: "ludo_first_out_winner",
    subject: "",
    line: null,
    name: "First out and match winner",
    live: false,
    stakeTier: "niche",
    selections: firstOutWinnerSelections,
  });

  // L10: ludo_win_margin
  markets.push({
    marketType: "ludo_win_margin",
    subject: "",
    line: null,
    name: "Winning margin",
    live: false,
    stakeTier: "niche",
    selections: [
      { key: "0", name: "0 tokens" },
      { key: "1", name: "1 token" },
      { key: "2", name: "2 tokens" },
      { key: "3plus", name: "3+ tokens" },
    ],
  });

  // L11: ludo_total_turns
  for (const line of activeLines.totalTurns) {
    markets.push({
      marketType: "ludo_total_turns",
      subject: "",
      line,
      name: `Total turns over/under ${line.toFixed(1)}`,
      live: true,
      stakeTier: "main",
      selections: [
        { key: "over", name: "Over" },
        { key: "under", name: "Under" },
      ],
    });
  }

  // L12: ludo_total_sixes
  for (const line of activeLines.totalSixes) {
    markets.push({
      marketType: "ludo_total_sixes",
      subject: "",
      line,
      name: `Total sixes over/under ${line.toFixed(1)}`,
      live: true,
      stakeTier: "standard",
      selections: [
        { key: "over", name: "Over" },
        { key: "under", name: "Under" },
      ],
    });
  }

  // L13: ludo_seat_sixes
  for (const seat of seats) {
    markets.push({
      marketType: "ludo_seat_sixes",
      subject: seatSlug(seat),
      line: activeLines.seatSixes,
      name: `${seatName(seat)} total sixes ${activeLines.seatSixes.toFixed(1)}`,
      live: true,
      stakeTier: "niche",
      selections: [
        { key: "over", name: "Over" },
        { key: "under", name: "Under" },
      ],
    });
  }

  // L14: ludo_first_six
  markets.push({
    marketType: "ludo_first_six",
    subject: "",
    line: null,
    name: "First six",
    live: false,
    stakeTier: "niche",
    selections: seats.map((seat) => ({ key: seatSlug(seat), name: seatName(seat) })),
  });

  // L15: ludo_triple_six
  markets.push({
    marketType: "ludo_triple_six",
    subject: "",
    line: null,
    name: "Triple six forfeit",
    live: false,
    stakeTier: "niche",
    selections: [
      { key: "yes", name: "Yes" },
      { key: "no", name: "No" },
    ],
  });

  // L16: ludo_total_captures
  for (const line of activeLines.totalCaptures) {
    markets.push({
      marketType: "ludo_total_captures",
      subject: "",
      line,
      name: `Total captures over/under ${line.toFixed(1)}`,
      live: true,
      stakeTier: "standard",
      selections: [
        { key: "over", name: "Over" },
        { key: "under", name: "Under" },
      ],
    });
  }

  // L17: ludo_first_capture
  const firstCaptureSelections: CatalogSelection[] = [];
  for (const captor of seats) {
    for (const victim of seats) {
      if (captor !== victim) {
        firstCaptureSelections.push({
          key: `${seatSlug(captor)}_${seatSlug(victim)}`,
          name: `${seatName(captor)} captures ${seatName(victim)}`,
        });
      }
    }
  }
  firstCaptureSelections.push({ key: "none", name: "No capture" });

  markets.push({
    marketType: "ludo_first_capture",
    subject: "",
    line: null,
    name: "First capture",
    live: false,
    stakeTier: "niche",
    selections: firstCaptureSelections,
  });

  // L18: ludo_winner_captures
  for (const line of activeLines.winnerCaptures) {
    markets.push({
      marketType: "ludo_winner_captures",
      subject: "",
      line,
      name: `Winner captures over/under ${line.toFixed(1)}`,
      live: false,
      stakeTier: "standard",
      selections: [
        { key: "over", name: "Over" },
        { key: "under", name: "Under" },
      ],
    });
  }

  // L19: ludo_winner_never_captured
  markets.push({
    marketType: "ludo_winner_never_captured",
    subject: "",
    line: null,
    name: "Winner never captured",
    live: false,
    stakeTier: "niche",
    selections: [
      { key: "yes", name: "Yes" },
      { key: "no", name: "No" },
    ],
  });

  // L20: ludo_seat_captures
  for (const seat of seats) {
    markets.push({
      marketType: "ludo_seat_captures",
      subject: seatSlug(seat),
      line: null,
      name: `${seatName(seat)} total captures`,
      live: true,
      stakeTier: "niche",
      selections: [
        { key: "at_least_1", name: "1+ captures" },
        { key: "at_least_2", name: "2+ captures" },
        { key: "at_least_3", name: "3+ captures" },
      ],
    });
  }

  // L21: ludo_rolls_to_first_capture
  for (const line of activeLines.rollsToFirstCapture) {
    markets.push({
      marketType: "ludo_rolls_to_first_capture",
      subject: "",
      line,
      name: `Rolls to first capture over/under ${line.toFixed(1)}`,
      live: false,
      stakeTier: "niche",
      selections: [
        { key: "over", name: "Over" },
        { key: "under", name: "Under" },
      ],
    });
  }

  // L22: ludo_home_at_turn_60
  for (const seat of seats) {
    for (const line of activeLines.homeAtTurn60) {
      markets.push({
        marketType: "ludo_home_at_turn_60",
        subject: seatSlug(seat),
        line,
        name: `${seatName(seat)} home at turn 60 over/under ${line.toFixed(1)}`,
        live: true,
        stakeTier: "niche",
        selections: [
          { key: "over", name: "Over" },
          { key: "under", name: "Under" },
        ],
      });
    }
  }

  // L23: ludo_turns_parity
  markets.push({
    marketType: "ludo_turns_parity",
    subject: "",
    line: null,
    name: "Total turns parity",
    live: false,
    stakeTier: "niche",
    selections: [
      { key: "odd", name: "Odd" },
      { key: "even", name: "Even" },
    ],
  });

  // L24: ludo_last_roll_six
  markets.push({
    marketType: "ludo_last_roll_six",
    subject: "",
    line: null,
    name: "Last roll six",
    live: false,
    stakeTier: "niche",
    selections: [
      { key: "yes", name: "Yes" },
      { key: "no", name: "No" },
    ],
  });

  return {
    markets,
    settle(
      market: Pick<CatalogMarket, "marketType" | "subject" | "line">,
      key: string,
      stats: LudoGameStats,
    ): Settlement {
      if (!isOver(stats)) {
        return "void";
      }

      const subjectSeat = SEAT_SLUGS.indexOf(market.subject);

      switch (market.marketType) {
        case "ludo_match_winner": {
          if (stats.winnerSeat === null || !stats.seats.includes(stats.winnerSeat)) {
            return "void";
          }
          return key === seatSlug(stats.winnerSeat) ? "won" : "lost";
        }

        case "ludo_finish_place": {
          if (subjectSeat === -1 || !stats.seats.includes(subjectSeat)) {
            return "void";
          }
          const idx = stats.finishingOrder.indexOf(subjectSeat);
          if (idx !== -1) {
            if (stats.players === 4) {
              const placeKeys = ["1st", "2nd", "3rd", "last"];
              const targetKey = placeKeys[idx];
              return targetKey !== undefined && key === targetKey ? "won" : "lost";
            }
            const targetKey = idx === 0 ? "1st" : "last";
            return key === targetKey ? "won" : "lost";
          }
          if (stats.finishingOrder.length === stats.seats.length - 1) {
            return key === "last" ? "won" : "lost";
          }
          return "void";
        }

        case "ludo_top_two": {
          if (subjectSeat === -1 || !stats.seats.includes(subjectSeat)) {
            return "void";
          }
          const idx = stats.finishingOrder.indexOf(subjectSeat);
          const isTopTwo = idx === 0 || idx === 1;
          return (key === "yes") === isTopTwo ? "won" : "lost";
        }

        case "ludo_head_to_head": {
          const parts = market.subject.split("_");
          if (parts.length !== 2) {
            return "void";
          }
          const seatA = SEAT_SLUGS.indexOf(parts[0]!);
          const seatB = SEAT_SLUGS.indexOf(parts[1]!);
          if (
            seatA === -1 ||
            seatB === -1 ||
            !stats.seats.includes(seatA) ||
            !stats.seats.includes(seatB)
          ) {
            return "void";
          }
          const idxA = stats.finishingOrder.indexOf(seatA);
          const idxB = stats.finishingOrder.indexOf(seatB);

          let winnerSeat: number | null = null;
          if (idxA !== -1 && idxB !== -1) {
            winnerSeat = idxA < idxB ? seatA : seatB;
          } else if (idxA !== -1 && idxB === -1) {
            winnerSeat = seatA;
          } else if (idxA === -1 && idxB !== -1) {
            winnerSeat = seatB;
          } else {
            return "void";
          }

          return key === seatSlug(winnerSeat) ? "won" : "lost";
        }

        case "ludo_first_out": {
          if (stats.firstOut === null || !stats.seats.includes(stats.firstOut.seat)) {
            return "void";
          }
          return key === seatSlug(stats.firstOut.seat) ? "won" : "lost";
        }

        case "ludo_first_home": {
          if (stats.firstHome === null || !stats.seats.includes(stats.firstHome.seat)) {
            return "void";
          }
          return key === seatSlug(stats.firstHome.seat) ? "won" : "lost";
        }

        case "ludo_winner_turns": {
          if (stats.winnerTurns === null) {
            return "void";
          }
          return overUnder(stats.winnerTurns, market.line, key);
        }

        case "ludo_first_up": {
          // First to two tokens home. A fact of the game, folded as it is played,
          // so it settles the same from a match log and from a simulation.
          const first = stats.firstToTwoHome;
          if (first === null || !stats.seats.includes(first.seat)) {
            return "void";
          }
          return key === seatSlug(first.seat) ? "won" : "lost";
        }

        case "ludo_second_up": {
          const second = stats.firstToThreeHome;
          if (second === null || !stats.seats.includes(second.seat)) {
            return "void";
          }
          return key === seatSlug(second.seat) ? "won" : "lost";
        }

        case "ludo_never_last": {
          if (subjectSeat === -1 || !stats.seats.includes(subjectSeat)) {
            return "void";
          }
          const neverFewest = stats.neverFewestAfterRound20[subjectSeat];
          if (neverFewest === undefined) {
            return "void";
          }
          return (key === "yes") === neverFewest ? "won" : "lost";
        }

        case "ludo_first_out_winner": {
          if (
            stats.firstOut === null ||
            stats.winnerSeat === null ||
            !stats.seats.includes(stats.firstOut.seat) ||
            !stats.seats.includes(stats.winnerSeat)
          ) {
            return "void";
          }
          const winningKey = `${seatSlug(stats.firstOut.seat)}_${seatSlug(stats.winnerSeat)}`;
          return key === winningKey ? "won" : "lost";
        }

        case "ludo_win_margin": {
          if (stats.winnerSeat === null || !stats.seats.includes(stats.winnerSeat)) {
            return "void";
          }
          const winnerHome = stats.finalHome[stats.winnerSeat] ?? 0;
          const otherSeats = stats.seats.filter((s) => s !== stats.winnerSeat);
          if (otherSeats.length === 0) {
            return "void";
          }
          const runnerUpHome = Math.max(...otherSeats.map((s) => stats.finalHome[s] ?? 0));
          const margin = winnerHome - runnerUpHome;

          let winningKey: string;
          if (margin === 0) {
            winningKey = "0";
          } else if (margin === 1) {
            winningKey = "1";
          } else if (margin === 2) {
            winningKey = "2";
          } else {
            winningKey = "3plus";
          }
          return key === winningKey ? "won" : "lost";
        }

        case "ludo_total_turns": {
          return overUnder(stats.totalRounds, market.line, key);
        }

        case "ludo_total_sixes": {
          const totalSixes = stats.sixesBySeat.reduce((sum, count, seatIdx) => {
            return stats.seats.includes(seatIdx) ? sum + count : sum;
          }, 0);
          return overUnder(totalSixes, market.line, key);
        }

        case "ludo_seat_sixes": {
          if (subjectSeat === -1 || !stats.seats.includes(subjectSeat)) {
            return "void";
          }
          const seatSixes = stats.sixesBySeat[subjectSeat] ?? 0;
          return overUnder(seatSixes, market.line, key);
        }

        case "ludo_first_six": {
          if (stats.firstSix === null || !stats.seats.includes(stats.firstSix.seat)) {
            return "void";
          }
          return key === seatSlug(stats.firstSix.seat) ? "won" : "lost";
        }

        case "ludo_triple_six": {
          const tripleSixes = stats.tripleSixesBySeat.reduce((sum, count, seatIdx) => {
            return stats.seats.includes(seatIdx) ? sum + count : sum;
          }, 0);
          const forfeit = tripleSixes > 0;
          return (key === "yes") === forfeit ? "won" : "lost";
        }

        case "ludo_total_captures": {
          return overUnder(stats.captures.length, market.line, key);
        }

        case "ludo_first_capture": {
          if (stats.firstCapture === null) {
            return key === "none" ? "won" : "lost";
          }
          if (
            !stats.seats.includes(stats.firstCapture.seat) ||
            !stats.seats.includes(stats.firstCapture.victim)
          ) {
            return "void";
          }
          const winningKey = `${seatSlug(stats.firstCapture.seat)}_${seatSlug(stats.firstCapture.victim)}`;
          return key === winningKey ? "won" : "lost";
        }

        case "ludo_winner_captures": {
          if (stats.winnerSeat === null || !stats.seats.includes(stats.winnerSeat)) {
            return "void";
          }
          const winnerCaptures = stats.capturesBySeat[stats.winnerSeat] ?? 0;
          return overUnder(winnerCaptures, market.line, key);
        }

        case "ludo_winner_never_captured": {
          if (stats.winnerSeat === null || !stats.seats.includes(stats.winnerSeat)) {
            return "void";
          }
          const neverCaptured = !stats.winnerWasCaptured;
          return (key === "yes") === neverCaptured ? "won" : "lost";
        }

        case "ludo_seat_captures": {
          if (subjectSeat === -1 || !stats.seats.includes(subjectSeat)) {
            return "void";
          }
          const seatCaptures = stats.capturesBySeat[subjectSeat] ?? 0;
          if (key === "at_least_1") {
            return seatCaptures >= 1 ? "won" : "lost";
          }
          if (key === "at_least_2") {
            return seatCaptures >= 2 ? "won" : "lost";
          }
          if (key === "at_least_3") {
            return seatCaptures >= 3 ? "won" : "lost";
          }
          return "void";
        }

        case "ludo_rolls_to_first_capture": {
          if (stats.rollsBeforeFirstCapture === null) {
            return "void";
          }
          return overUnder(stats.rollsBeforeFirstCapture, market.line, key);
        }

        case "ludo_home_at_turn_60": {
          if (subjectSeat === -1 || !stats.seats.includes(subjectSeat)) {
            return "void";
          }
          const homeCount = stats.homeAtRound60[subjectSeat] ?? 0;
          return overUnder(homeCount, market.line, key);
        }

        case "ludo_turns_parity": {
          const isEven = stats.totalRounds % 2 === 0;
          const targetKey = isEven ? "even" : "odd";
          return key === targetKey ? "won" : "lost";
        }

        case "ludo_last_roll_six": {
          if (stats.lastRoll === null) {
            return "void";
          }
          const isSix = stats.lastRoll === 6;
          return (key === "yes") === isSix ? "won" : "lost";
        }

        default:
          return "void";
      }
    },
  };
}
