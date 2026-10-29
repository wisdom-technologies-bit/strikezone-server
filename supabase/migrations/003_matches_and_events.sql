-- 003_matches_and_events.sql
--
-- Matches, their seats and their hash-chained event log. No money columns.
--
-- matches.tournament_id cannot carry its foreign key here because
-- public.tournaments is created by 004; the constraint is added at the end of
-- that file, once the table exists.

begin;

-- ---------------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------------
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  game text not null,
  tournament_id uuid,
  status text not null default 'scheduled',
  seed_commit text,
  seed_reveal text,
  config jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  result jsonb,
  result_signature text,
  log_head_hash text,
  constraint matches_game_check check (game in ('carrom', 'ludo')),
  constraint matches_status_check
    check (status in ('scheduled', 'live', 'finished', 'void')),
  constraint matches_time_order_check
    check (ended_at is null or started_at is null or ended_at >= started_at),
  constraint matches_seed_reveal_after_finish_check
    check (seed_reveal is null or status in ('finished', 'void')),
  constraint matches_live_has_started_check
    check (status <> 'live' or started_at is not null)
);

comment on table public.matches is
  'One game of carrom or ludo: its configuration, provably fair seed, lifecycle and signed result.';
comment on column public.matches.game is
  'carrom or ludo.';
comment on column public.matches.tournament_id is
  'Set when the match is part of a tournament bracket. Foreign key added in 004, where tournaments is created.';
comment on column public.matches.status is
  'scheduled, live, finished or void.';
comment on column public.matches.seed_commit is
  'Hash of the seed, published before the match so nobody can predict the shuffle.';
comment on column public.matches.seed_reveal is
  'The seed itself, stored only once the match is finished or void, so the commit can be verified.';
comment on column public.matches.config is
  'Game rules and options for this match as JSON, for example board layout or turn timer.';
comment on column public.matches.scheduled_at is
  'Planned start time. Null for ad hoc matches.';
comment on column public.matches.started_at is
  'When play began.';
comment on column public.matches.ended_at is
  'When the match reached finished or void.';
comment on column public.matches.result is
  'Final result as JSON, for example winners and per-seat scores.';
comment on column public.matches.result_signature is
  'Signature over the result, produced with the server result signing secret, so payout code can verify the result was not tampered with.';
comment on column public.matches.log_head_hash is
  'Hash of the last event in the match log, which commits to the whole chain.';

create index if not exists matches_tournament_id_idx on public.matches (tournament_id);
create index if not exists matches_status_scheduled_at_idx on public.matches (status, scheduled_at);
create index if not exists matches_game_status_idx on public.matches (game, status);

-- ---------------------------------------------------------------------------
-- match_players: who sat where
-- ---------------------------------------------------------------------------
create table if not exists public.match_players (
  match_id uuid not null references public.matches (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete restrict,
  seat integer not null,
  primary key (match_id, seat),
  constraint match_players_seat_check check (seat between 1 and 4),
  constraint match_players_match_player_key unique (match_id, player_id)
);

comment on table public.match_players is
  'Seat assignment per match. Seat 1 is the first player; carrom supports 2 or 4 seats, ludo 2 to 4.';
comment on column public.match_players.seat is
  'Seat number from 1 to 4. Part of the primary key, so a seat is unique within a match.';
comment on column public.match_players.player_id is
  'The seated player. A player joins a match at most once.';

create index if not exists match_players_player_id_idx on public.match_players (player_id);

-- ---------------------------------------------------------------------------
-- match_events: append-only, hash-chained game log
-- ---------------------------------------------------------------------------
create table if not exists public.match_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  seq integer not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  prev_hash text,
  hash text,
  constraint match_events_seq_check check (seq >= 1),
  constraint match_events_type_not_blank_check check (btrim(type) <> ''),
  constraint match_events_match_seq_key unique (match_id, seq)
);

comment on table public.match_events is
  'Append-only log of everything that happened in a match. Each row carries prev_hash and hash, so the server can prove no event was inserted, removed or edited afterwards.';
comment on column public.match_events.seq is
  'Position in the match log, starting at 1 and increasing by one. Unique per match.';
comment on column public.match_events.type is
  'Event type, for example shot, foul, turn_end or match_end.';
comment on column public.match_events.payload is
  'Event body as JSON.';
comment on column public.match_events.prev_hash is
  'Hash of the previous event, null for the first event in the match.';
comment on column public.match_events.hash is
  'Hash of this event including prev_hash, forming the chain whose head is matches.log_head_hash.';

-- The event log is append-only, exactly like the ledger.
drop trigger if exists match_events_append_only on public.match_events;
create trigger match_events_append_only
  before update or delete on public.match_events
  for each statement execute function public.reject_mutation();

commit;
