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

## The schema change: `supabase/migrations/010_ludo_heats.sql`

Written and verified against a throwaway Postgres 15, not yet applied to the live
project. What it does:

```sql
create table tournament_match_entrants (
  id                   uuid primary key default gen_random_uuid(),
  tournament_match_id  uuid not null references tournament_matches (id) on delete cascade,
  tournament_id        uuid not null references tournaments (id) on delete cascade,
  seat                 smallint not null check (seat between 1 and 4),
  player_id            uuid not null references players (id) on delete cascade,
  place                smallint check (place between 1 and 4),  -- null until decided
  created_at           timestamptz not null default now(),
  unique (tournament_match_id, seat),
  unique (tournament_match_id, player_id)
);

alter table tournament_matches
  add column format_seats smallint not null default 2 check (format_seats between 2 and 4),
  add column finishing_order uuid[];

alter table tournaments
  add column advance_per_heat smallint not null default 2 check (advance_per_heat between 1 and 3);
```

Three details that are not obvious:

- **An entrant's entry has no id to point at.** `tournament_entries` is keyed
  `(tournament_id, player_id)`, and 008 never gave it a surrogate key, so the
  entrants table carries the pair and does not foreign-key it: a bot filled in at
  launch has no entry at all, and a `not null` pair would have refused to hold the
  seat it plays.
- **`place` is unique per position when set.** A partial unique index
  (`where place is not null`) stops two entrants tying for a place without
  refusing a position that has not been decided yet.
- **One writer, no trigger.** Two-seat positions keep their seat columns and get a
  matching pair of entrant rows; heats write entrant rows only. A trigger mirroring
  one into the other would fire during the scheduler's own advancement, which is
  the one place a bracket must not rewrite itself mid-decision.

The `tournaments.format` constraint is dropped and recreated to allow `heats`
(004 had already allowed `swiss`, which no format implements).

## What was verified, and how

The migration was applied to a scratch cluster with a Supabase-shaped scaffold
(`auth.users`, `auth.uid()`, the `anon`/`authenticated`/`service_role` roles, and a
`supabase_realtime` publication), after 001 through 009:

1. **It runs.** Migrations 001 to 010 apply with `ON_ERROR_STOP` and no errors.
2. **It is idempotent.** Running 010 a second time changes nothing and reports no
   error beyond the expected "policy does not exist, skipping".
3. **The backfill mirrors.** A finished two-seat position inserted before the
   re-run produced two entrant rows with places 1 and 2.
4. **A heat works end to end.** A four-seat position took four entrants, four
   places, and a `finishing_order` array of length four; the top two came back in
   finishing order with one query.
5. **Every constraint bites.** A duplicate place, a fifth seat, `format_seats = 5`,
   `advance_per_heat = 4` and an unknown format each raise; `format = 'heats'` is
   accepted.
6. **Access matches the bracket table.** `anon` reads the entrants and cannot
   write them.

`supabase/migrations/009_money_extras.sql` is applied to the live project;
`010_ludo_heats.sql` is not.

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

## Where this stands

The migration is written; the code is not. Applying 010 on its own changes nothing
for anyone: no code reads the new table yet, so the two-seat formats keep running
exactly as they do now. The heats format lands next, with the tests above, once the
column is in the live database.

Until then Ludo runs the two-seat formats. That is honest about the schedule - every
match that exists is a real bracket position with two entrants - but it does not use
the board's four seats.
