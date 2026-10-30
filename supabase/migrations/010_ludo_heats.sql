-- 010_ludo_heats.sql
--
-- A bracket position that seats four.
--
-- Until now a position held exactly two entrants: seat_1_player_id and
-- seat_2_player_id, a winner, a loser, and a points object with two numbers.
-- That is enough for Carrom and for the two-seat Ludo knockouts, and it cannot
-- express a Ludo heat, where four players sit down together and the top two
-- advance.
--
-- This migration adds the entrant table, the finishing order a heat reports, and
-- the two knobs the format reads. It is additive: the two seat columns keep their
-- meaning, nothing is dropped, and every existing row keeps working untouched.
--
-- Who writes what, after this migration:
--
--   * a two-seat format writes seat_1/seat_2 plus a matching pair of entrant rows
--     (created_at aside, the two views agree);
--   * a heat writes entrant rows only, and reports finishing_order when it ends;
--   * reads use the entrant rows when format_seats > 2 and the seat columns
--     otherwise, so an index scan over the old shape stays exactly as it is.
--
-- There is deliberately no trigger keeping the two in step. Two writers in one
-- transaction are predictable; a trigger that rewrites a bracket position from
-- its entrants would fire during the scheduler's own advancement and turn an
-- ordering question into a recursion one.
--
-- Safe to run once, and safe to run again: every object is guarded.

begin;

-- ---------------------------------------------------------------------------
-- tournament_match_entrants: everyone who sat at a bracket position
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_match_entrants (
  id uuid primary key default gen_random_uuid(),
  tournament_match_id uuid not null
    references public.tournament_matches (id) on delete cascade,
  tournament_id uuid not null
    references public.tournaments (id) on delete cascade,
  seat smallint not null,
  player_id uuid not null references public.players (id) on delete cascade,
  place smallint,
  created_at timestamptz not null default now(),
  constraint tournament_match_entrants_seat_check check (seat between 1 and 4),
  constraint tournament_match_entrants_place_check
    check (place is null or place between 1 and 4),
  constraint tournament_match_entrants_seat_key unique (tournament_match_id, seat),
  constraint tournament_match_entrants_player_key
    unique (tournament_match_id, player_id)
);

comment on table public.tournament_match_entrants is
  'One row per entrant at a bracket position. Authoritative for a heat (three or four seats); mirrors seat_1/seat_2 for a two-seat position.';
comment on column public.tournament_match_entrants.seat is
  'The seat, 1 to 4, in the order the entrants were placed into the position.';
comment on column public.tournament_match_entrants.player_id is
  'Who sits here. A bye is an absent row, not a row with a null player.';
-- An entrant's entry is identified by (tournament_id, player_id): tournament_entries
-- has that pair as its primary key, so there is no entry id to point at. Every
-- entrant at a tournament position has an entry unless it was a bot filled in at
-- launch, which is why the pair is not a foreign key here.
comment on column public.tournament_match_entrants.place is
  'Where this entrant finished, 1 is the winner. Null while the position is undecided, and for a walkover nobody turned up to.';

-- Two entrants cannot tie for a place, and a position cannot have two fourths.
create unique index if not exists tournament_match_entrants_place_idx
  on public.tournament_match_entrants (tournament_match_id, place)
  where place is not null;

create index if not exists tournament_match_entrants_match_idx
  on public.tournament_match_entrants (tournament_match_id, seat);
create index if not exists tournament_match_entrants_tournament_idx
  on public.tournament_match_entrants (tournament_id);
create index if not exists tournament_match_entrants_player_idx
  on public.tournament_match_entrants (player_id);

-- ---------------------------------------------------------------------------
-- tournament_matches: how many seats the position has, and the order it ended in
-- ---------------------------------------------------------------------------
alter table public.tournament_matches
  add column if not exists format_seats smallint not null default 2,
  add column if not exists finishing_order uuid[];

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tournament_matches_format_seats_check'
      and conrelid = 'public.tournament_matches'::regclass
  ) then
    alter table public.tournament_matches
      add constraint tournament_matches_format_seats_check
      check (format_seats between 2 and 4);
  end if;
end $$;

comment on column public.tournament_matches.format_seats is
  'How many entrants this position seats: 2 for a knockout, up to 4 for a heat.';
comment on column public.tournament_matches.finishing_order is
  'Player ids in the order the referee reported them, best first. Set by a heat; null for a two-seat position, whose winner and loser columns carry the same fact.';

-- ---------------------------------------------------------------------------
-- tournaments: the format and how many of a heat advance
-- ---------------------------------------------------------------------------
alter table public.tournaments
  add column if not exists advance_per_heat smallint not null default 2;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tournaments_advance_per_heat_check'
      and conrelid = 'public.tournaments'::regclass
  ) then
    alter table public.tournaments
      add constraint tournaments_advance_per_heat_check
      check (advance_per_heat between 1 and 3);
  end if;
end $$;

comment on column public.tournaments.advance_per_heat is
  'How many entrants a heat sends on. Three of four is a knockout with a repechage of one; the column is read only by the heats format.';

-- 004 allowed swiss in the constraint but the build never ran it. Drop and
-- recreate, so the constraint says what the code can actually do: the two
-- knockouts this server shipped, swiss for the version that lands next, and
-- heats.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'tournaments_format_check'
      and conrelid = 'public.tournaments'::regclass
  ) then
    alter table public.tournaments drop constraint tournaments_format_check;
  end if;

  alter table public.tournaments
    add constraint tournaments_format_check
    check (format in ('single_elimination', 'round_robin', 'swiss', 'heats'));
end $$;

comment on column public.tournaments.format is
  'single_elimination, round_robin, swiss or heats. A heats tournament seats two to four per position and advances advance_per_heat of them.';

-- ---------------------------------------------------------------------------
-- Backfill: every position that already has players gets its entrant rows
-- ---------------------------------------------------------------------------
-- Two-seat positions are mirrored rather than migrated: the seat columns stay the
-- source of truth for them, and the entrant rows give the bracket loader one shape
-- to read whatever the format. Finished positions get their places too, so a
-- replay of an old tournament reads correctly.
insert into public.tournament_match_entrants
  (tournament_match_id, tournament_id, seat, player_id, place)
select
  m.id,
  m.tournament_id,
  1,
  m.seat_1_player_id,
  case
    when m.status in ('finished', 'walkover') and m.winner_player_id = m.seat_1_player_id then 1
    when m.status in ('finished', 'walkover') and m.loser_player_id = m.seat_1_player_id then 2
  end
from public.tournament_matches m
where m.seat_1_player_id is not null
on conflict do nothing;

insert into public.tournament_match_entrants
  (tournament_match_id, tournament_id, seat, player_id, place)
select
  m.id,
  m.tournament_id,
  2,
  m.seat_2_player_id,
  case
    when m.status in ('finished', 'walkover') and m.winner_player_id = m.seat_2_player_id then 1
    when m.status in ('finished', 'walkover') and m.loser_player_id = m.seat_2_player_id then 2
  end
from public.tournament_matches m
where m.seat_2_player_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Access: public to read, service role to write, exactly like the bracket table
-- ---------------------------------------------------------------------------
alter table public.tournament_match_entrants enable row level security;

drop policy if exists tournament_match_entrants_select_public
  on public.tournament_match_entrants;
create policy tournament_match_entrants_select_public
  on public.tournament_match_entrants
  for select to anon, authenticated
  using (true);

revoke all on public.tournament_match_entrants from anon, authenticated;
grant select on public.tournament_match_entrants to anon, authenticated;

-- The website draws a live bracket, so the entrants stream to it the way the
-- positions already do.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tournament_match_entrants'
    ) then
      alter publication supabase_realtime
        add table public.tournament_match_entrants;
    end if;
  end if;
end $$;

commit;
