-- 004_tournaments.sql
--
-- Tournaments, their entry list and their bracket. Money columns
-- (entry_fee_minor, prize_pool_minor) are bigint counts of the smallest unit.

begin;

-- ---------------------------------------------------------------------------
-- tournaments
-- ---------------------------------------------------------------------------
create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  game text not null,
  name text not null,
  format text not null,
  status text not null default 'draft',
  entry_fee_minor bigint not null default 0,
  prize_pool_minor bigint not null default 0,
  max_players integer,
  starts_at timestamptz,
  config jsonb not null default '{}'::jsonb,
  constraint tournaments_game_check check (game in ('carrom', 'ludo')),
  constraint tournaments_format_check
    check (format in ('single_elimination', 'round_robin', 'swiss')),
  constraint tournaments_status_check
    check (status in ('draft', 'registration', 'running', 'finished', 'cancelled')),
  constraint tournaments_entry_fee_minor_check check (entry_fee_minor >= 0),
  constraint tournaments_prize_pool_minor_check check (prize_pool_minor >= 0),
  constraint tournaments_max_players_check check (max_players is null or max_players > 1),
  constraint tournaments_name_not_blank_check check (btrim(name) <> '')
);

comment on table public.tournaments is
  'A scheduled competition: its format, entry fee, prize pool and lifecycle.';
comment on column public.tournaments.format is
  'single_elimination, round_robin or swiss.';
comment on column public.tournaments.status is
  'draft, registration, running, finished or cancelled.';
comment on column public.tournaments.entry_fee_minor is
  'Entry fee in the smallest currency unit, taken through the ledger as tournament_entry.';
comment on column public.tournaments.prize_pool_minor is
  'Prize money in the smallest currency unit, paid out through the ledger as tournament_prize.';
comment on column public.tournaments.max_players is
  'Registration cap. Null means no cap.';
comment on column public.tournaments.config is
  'Format-specific settings as JSON, for example rounds, board size or time controls.';

create index if not exists tournaments_status_starts_at_idx on public.tournaments (status, starts_at);
create index if not exists tournaments_game_status_idx on public.tournaments (game, status);

-- ---------------------------------------------------------------------------
-- matches.tournament_id: the foreign key 003 could not declare yet
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'matches_tournament_id_fkey'
      and conrelid = 'public.matches'::regclass
  ) then
    alter table public.matches
      add constraint matches_tournament_id_fkey
      foreign key (tournament_id) references public.tournaments (id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- tournament_entries: who is in
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_entries (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete restrict,
  seed integer,
  status text not null default 'registered',
  primary key (tournament_id, player_id),
  constraint tournament_entries_status_check
    check (status in ('registered', 'active', 'eliminated', 'winner')),
  constraint tournament_entries_seed_check check (seed is null or seed >= 1)
);

comment on table public.tournament_entries is
  'One row per player entered in a tournament, with their bracket seed and progress.';
comment on column public.tournament_entries.seed is
  'Bracket position, unique per tournament when set. Null until seeds are drawn.';
comment on column public.tournament_entries.status is
  'registered, active, eliminated or winner.';

create unique index if not exists tournament_entries_seed_key
  on public.tournament_entries (tournament_id, seed)
  where seed is not null;

create index if not exists tournament_entries_player_id_idx
  on public.tournament_entries (player_id);

-- ---------------------------------------------------------------------------
-- tournament_matches: the bracket itself
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  round integer not null,
  slot integer not null,
  match_id uuid references public.matches (id) on delete set null,
  winner_to_slot integer,
  constraint tournament_matches_round_check check (round >= 1),
  constraint tournament_matches_slot_check check (slot >= 1),
  constraint tournament_matches_winner_to_slot_check
    check (winner_to_slot is null or winner_to_slot >= 1),
  constraint tournament_matches_tournament_round_slot_key unique (tournament_id, round, slot)
);

comment on table public.tournament_matches is
  'A bracket position: round and slot inside a tournament, the match that fills it, and where its winner goes next.';
comment on column public.tournament_matches.round is
  'Round number, starting at 1.';
comment on column public.tournament_matches.slot is
  'Slot number inside the round, starting at 1. Round plus slot identifies a bracket position.';
comment on column public.tournament_matches.match_id is
  'The match played at this position. Null until the bracket position is filled.';
comment on column public.tournament_matches.winner_to_slot is
  'Slot in round + 1 that this position''s winner advances to. Null in the final.';

create index if not exists tournament_matches_tournament_id_idx
  on public.tournament_matches (tournament_id, round);
create index if not exists tournament_matches_match_id_idx
  on public.tournament_matches (match_id);

commit;
