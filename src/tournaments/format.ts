import type {
  DecidedPosition,
  FinishPlace,
  FormatEntrant,
  FormatOutcome,
  FormatPlan,
  PlannedPosition,
  TournamentFormatKind,
} from "./types.js";
import { roundRobinFormat } from "./round-robin.js";
import { singleEliminationFormat } from "./single-elimination.js";

/**
 * The format strategy.
 *
 * A format owns three questions and nothing else: what the schedule is, where a
 * winner goes next, and who finished where. The service owns the lifecycle, the
 * database and the money, and never asks which format is running.
 *
 * Adding Swiss means writing one file that answers these three questions and
 * registering it below. Nothing else changes, which is the whole point of the
 * seam.
 */

/** Where the winner of one position moves to. */
export interface NextSeat {
  readonly round: number;
  readonly slot: number;
  readonly seat: 1 | 2;
}

/** One bracket format. */
export interface TournamentFormat {
  readonly kind: TournamentFormatKind;
  /** Fewest entrants the format can run with. */
  readonly minPlayers: number;
  /** Most entrants the format can run with. */
  readonly maxPlayers: number;
  /** The whole schedule for this many entrants. */
  plan(entrants: number): FormatPlan;
  /** Where the winner goes, or null when the format has no next round. */
  nextSeat(position: Pick<PlannedPosition, "round" | "slot" | "winnerToSlot">): NextSeat | null;
  /** The read on progress: done or not, and the finishing order when done. */
  summarise(
    plan: FormatPlan,
    positions: readonly DecidedPosition[],
    entrants: readonly FormatEntrant[],
  ): FormatOutcome;
}

const FORMATS: ReadonlyMap<TournamentFormatKind, TournamentFormat> = new Map<
  TournamentFormatKind,
  TournamentFormat
>([
  [singleEliminationFormat.kind, singleEliminationFormat],
  [roundRobinFormat.kind, roundRobinFormat],
]);

/** The strategy for a format name. Throws for one that is not registered. */
export function formatFor(kind: TournamentFormatKind): TournamentFormat {
  const format = FORMATS.get(kind);
  if (format === undefined) {
    throw new Error(`no format registered for ${String(kind)}`);
  }
  return format;
}

/** Every registered format, for the API and for the admin form. */
export function registeredFormats(): readonly TournamentFormat[] {
  return [...FORMATS.values()];
}

/**
 * The shared "winner goes to round + 1, slot winnerToSlot" rule of a knockout.
 * The seat follows the slot's parity: the odd slot feeds seat 1, the even feeds
 * seat 2, which is why slot 8 and slot 9 both feed slot 5.
 */
export function knockoutNextSeat(
  position: Pick<PlannedPosition, "round" | "slot" | "winnerToSlot">,
): NextSeat | null {
  if (position.winnerToSlot === null) {
    return null;
  }
  return {
    round: position.round + 1,
    slot: position.winnerToSlot,
    seat: position.slot % 2 === 1 ? 1 : 2,
  };
}

/** Orders places deterministically: place 1 first, ties already broken. */
export function sortPlaces(places: readonly FinishPlace[]): readonly FinishPlace[] {
  return [...places].sort((left, right) => left.place - right.place);
}
