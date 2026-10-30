# Ludo tournaments - how heats fit, and what must change first

This is a design note for the one part of Ludo that is not wired: the four-seat
heat. It records the decision, the schema it needs, and the code that follows from
it, so the work is a plan rather than a surprise.

## What a heat is

A Ludo heat seats up to four entrants in one match. The match produces a finishing
order (the referee's `finishingOrder`), and the heats format advances the first two
to the next round. Compared with the two-seat knockouts already supported:

| | two-seat knockout | four-seat heat |
| --- | --- | --- |
| Entrants per position | 2 | 2 to 4 |
| How a position resolves | winner and loser | a finishing order for everyone |
| Who advances | the winner, one seat | the top `advancePerHeat`, several seats |
| Byes | an empty seat | an under-filled heat |

## Why it is blocked, precisely

The tournament layer is two-seat by construction, and the constraint is in four
places at once:

1. `tournament_matches` has `seat1_player_id` and `seat2_player_id` columns, a
   `points` column holding `{ seat1, seat2 }`, and a single `winner_player_id`.
   There is nowhere to put a third or fourth entrant, and nowhere to put places.
2. `PositionSeat` is `1 | 2` (`src/tournaments/types.ts`), so the type system
   refuses a seat 3 even if the database allowed it.
3. `TournamentFormat.nextSeat()` returns one `{ round, slot, seat }` - the single
   place a winner goes. A heat advances two, into two different seats, in one or
   more later positions.
4. The scheduler launches one match per position with two seats
   (`src/tournaments/scheduler.ts`), and reads the result back as winner and loser.

A heat cannot be expressed inside those four shapes without lying about one of
them: two "heats" sharing a match id is not a schedule, and a finishing order
compressed into a winner field is not a result. Hence: schema first.

## The schema change (migration `010_ludo_heats.sql`)

The smallest change that keeps the existing formats untouched:

```sql
-- One row per entrant in a position, ordered by the seat they occupy.
create table tournament_match_entrants (
  id                   uuid primary key default gen_random_uuid(),
  tournament_match_id  uuid not null references tournament_matches(id) on delete cascade,
  seat                 smallint not null check (seat between 1 and 4),
  player_id            uuid not null references profiles(id),
  entry_id             uuid not null references tournament_entries(id),
  place                smallint check (place between 1 and 4),  -- null until decided
  created_at           timestamptz not null default now(),
  unique (tournament_match_id, seat),
  unique (tournament_match_id, player_id)
);

-- The order the referee reported, for the positions that use it.
alter table tournament_matches
  add column finishing_order uuid[] ,
  add column format_seats smallint not null default 2
    check (format_seats between 2 and 4);

-- seat1_player_id and seat2_player_id stay: a two-seat format writes them and the
-- entrants table is maintained in step, so existing reads and the API keep working.
```

Loading the entrants instead of the two columns is a projection, not a migration:
`loadBracket` reads entrants when `format_seats > 2` and the columns otherwise.

## The code that follows

- `PositionSeat` becomes `1 | 2 | 3 | 4`; `BracketPositionRecord` gains
  `entrants: readonly PositionEntrant[]` and `finishingOrder: readonly string[]`.
- `TournamentFormat` gains one method, `advanceFrom(position, outcome)`, returning
  an array of `NextSeat`. `nextSeat()` stays for the knockouts and is implemented as
  `advanceFrom()[0]` so there is one rule, not two.
- A new `heatsFormat` in `src/tournaments/heats.ts`: groups of four in seed order,
  the top `advancePerHeat` of each heat into the next round, under-filled heats
  filled with byes, a final heat that decides places one to four. Registered in
  `FORMATS`; `TOURNAMENT_FORMATS` gains `"heats"`, and the migration's check
  constraint on `tournaments.format` is dropped and recreated to match.
- `resolvePosition` reads `match.result.finishingOrder` (already written by the
  Ludo referee and verified by `verifyLudoMatch`) instead of winner and loser when
  `formatSeats` is 4.
- The scheduler launches `formatSeats` seats for a heat, with bots filling the
  empty ones, exactly as it does today for two.
- Prize split: entry fees, rake and the payout order already handle N places
  (`placePrizeMinor`), so a heat final pays four places rather than two. The
  `bot_prize_policy` rule is unchanged.

## Tests the change must bring

1. A heat of four advances exactly `advancePerHeat` entrants, in finishing order.
2. An under-filled heat (three entrants) still advances the configured number,
   taking the best of those present and passing the bye to the next round.
3. A walkover heat (no-shows) resolves without paying anyone.
4. A four-seat heat's prize split pays four places and reconciles to zero with the
   ledger, the way the two-seat tournament test does.
5. `resolvePosition` on a two-seat position is unchanged: the existing 36
   tournament tests pass without edits.

## Decision needed

The migration is the gate. Run it (or say the word and I will write it), and the
heats format lands with the tests above. Until then Ludo runs the two-seat formats,
which is honest about the schedule but does not use the board's four seats.
