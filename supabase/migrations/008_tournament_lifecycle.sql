-- 008_tournament_lifecycle.sql
--
-- What a tournament needs beyond 004: a registration window, a prize pool
-- account of its own, bracket positions that hold players rather than a match
-- id, the timing a scheduler acts on, and the lease that stops two servers from
-- running the same job twice.
--
-- Everything here is additive and safe to run once: columns use
-- `add column if not exists`, constraints are added only when absent, and the
-- functions are `create or replace`.

begin;

-- ---------------------------------------------------------------------------
-- tournaments: the registration window, the size, the money, the outcome
-- ---------------------------------------------------------------------------
alter table public.tournaments
  add column if not exists min_players integer,
  add column if not exists registration_opens_at timestamptz,
  add column if not exists registration_closes_at timestamptz,
  add column if not exists currency text,
  add column if not exists champion_player_id uuid references public.players (id) on delete set null,
  add column if not exists payouts jsonb,
  add column if not exists finished_at timestamptz,
  add column if not exists cancelled_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tournaments_min_players_check'
      and conrelid = 'public.tournaments'::regclass
  ) then
    alter table public.tournaments
      add constraint tournaments_min_players_check
      check (min_players is null or min_players > 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'tournaments_registration_window_check'
      and conrelid = 'public.tournaments'::regclass
  ) then
    alter table public.tournaments
      add constraint tournaments_registration_window_check
      check (
        registration_opens_at is null
        or registration_closes_at is null
        or registration_closes_at > registration_opens_at
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'tournaments_currency_format_check'
      and conrelid = 'public.tournaments'::regclass
  ) then
    alter table public.tournaments
      add constraint tournaments_currency_format_check
      check (currency is null or currency ~ '^[A-Z]{3}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'tournaments_players_check'
      and conrelid = 'public.tournaments'::regclass
  ) then
    alter table public.tournaments
      add constraint tournaments_players_check
      check (
        min_players is null
        or max_players is null
        or max_players >= min_players
      );
  end if;
end $$;

comment on column public.tournaments.min_players is
  'Fewest entries for the tournament to run. Below this at the deadline it is cancelled, or filled with bots when fillWithBots is set.';
comment on column public.tournaments.registration_opens_at is
  'When registration opens. The scheduler moves the tournament to registration at this time.';
comment on column public.tournaments.registration_closes_at is
  'Registration deadline. Entries, withdrawals and refunds all stop here.';
comment on column public.tournaments.currency is
  'Currency of entry_fee_minor and prize_pool_minor, from the wallet ledger adapter at creation time.';
comment on column public.tournaments.champion_player_id is
  'The winning player once the tournament has finished.';
comment on column public.tournaments.payouts is
  'JSON list of {playerId, place, amountMinor, viaBot} actually paid, written once when the tournament finishes.';
comment on column public.tournaments.finished_at is
  'When the tournament finished and prizes were paid.';
comment on column public.tournaments.cancelled_at is
  'When the tournament was cancelled and every entry fee refunded.';

create index if not exists tournaments_registration_closes_at_idx
  on public.tournaments (status, registration_closes_at);

-- ---------------------------------------------------------------------------
-- wallet_accounts.tournament_id: each tournament owns its prize pool
-- ---------------------------------------------------------------------------
alter table public.wallet_accounts
  add column if not exists tournament_id uuid references public.tournaments (id) on delete restrict;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'wallet_accounts_tournament_owner_check'
      and conrelid = 'public.wallet_accounts'::regclass
  ) then
    -- A prize pool belongs to exactly one tournament, and nothing else may name
    -- one: the pool balance can then be read straight off the account instead of
    -- being inferred from ledger history.
    alter table public.wallet_accounts
      add constraint wallet_accounts_tournament_owner_check
      check (
        (owner_type = 'prize_pool' and tournament_id is not null)
        or (owner_type <> 'prize_pool' and tournament_id is null)
      );
  end if;
end $$;

create unique index if not exists wallet_accounts_one_pool_per_tournament_key
  on public.wallet_accounts (tournament_id)
  where owner_type = 'prize_pool';

comment on column public.wallet_accounts.tournament_id is
  'The tournament that owns a prize_pool account. Null for user, house and escrow accounts.';
comment on index public.wallet_accounts_one_pool_per_tournament_key is
  'One prize pool per tournament, so entry fees and payouts of two tournaments can never mix.';

-- ---------------------------------------------------------------------------
-- tournament_entries: what was paid, when, and where the player got to
-- ---------------------------------------------------------------------------
alter table public.tournament_entries
  add column if not exists entry_fee_minor bigint,
  add column if not exists registered_at timestamptz,
  add column if not exists withdrawn_at timestamptz,
  add column if not exists eliminated_round integer,
  add column if not exists paid_transaction_id uuid references public.ledger_transactions (id) on delete set null,
  add column if not exists refunded_transaction_id uuid references public.ledger_transactions (id) on delete set null;

do $$
begin
  -- Withdrawing keeps the row: the ledger has the refund, and the entry list
  -- should still show who was in and stepped out.
  if exists (
    select 1 from pg_constraint
    where conname = 'tournament_entries_status_check'
      and conrelid = 'public.tournament_entries'::regclass
  ) then
    alter table public.tournament_entries drop constraint tournament_entries_status_check;
  end if;

  alter table public.tournament_entries
    add constraint tournament_entries_status_check
    check (status in ('registered', 'active', 'eliminated', 'winner', 'withdrawn'));
end $$;

comment on column public.tournament_entries.entry_fee_minor is
  'The entry fee this player actually paid, in the smallest unit, kept so a refund returns exactly that amount.';
comment on column public.tournament_entries.registered_at is
  'When the entry was accepted.';
comment on column public.tournament_entries.withdrawn_at is
  'When the player withdrew and was refunded, before the registration deadline.';
comment on column public.tournament_entries.eliminated_round is
  'The round the player went out in. Null for players still in.';
comment on column public.tournament_entries.paid_transaction_id is
  'The ledger transaction that took the entry fee.';
comment on column public.tournament_entries.refunded_transaction_id is
  'The ledger transaction that refunded the entry fee, if one was issued.';

create index if not exists tournament_entries_status_idx
  on public.tournament_entries (tournament_id, status);

-- ---------------------------------------------------------------------------
-- tournament_matches: the players at a bracket position, and its clock
-- ---------------------------------------------------------------------------
alter table public.tournament_matches
  add column if not exists seat_1_player_id uuid references public.players (id) on delete set null,
  add column if not exists seat_2_player_id uuid references public.players (id) on delete set null,
  add column if not exists status text not null default 'pending',
  add column if not exists due_at timestamptz,
  add column if not exists launched_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists winner_player_id uuid references public.players (id) on delete set null,
  add column if not exists loser_player_id uuid references public.players (id) on delete set null,
  add column if not exists is_walkover boolean not null default false,
  add column if not exists points jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tournament_matches_status_check'
      and conrelid = 'public.tournament_matches'::regclass
  ) then
    alter table public.tournament_matches
      add constraint tournament_matches_status_check
      check (status in ('pending', 'ready', 'live', 'finished', 'walkover', 'void'));
  end if;
end $$;

comment on column public.tournament_matches.seat_1_player_id is
  'The player in seat 1. Null while the position is still waiting for an entrant.';
comment on column public.tournament_matches.seat_2_player_id is
  'The player in seat 2. Null while the position is still waiting for an entrant.';
comment on column public.tournament_matches.status is
  'pending, ready, live, finished, walkover or void.';
comment on column public.tournament_matches.due_at is
  'When this match is due to be played. The walkover clock starts here.';
comment on column public.tournament_matches.launched_at is
  'When the room for this match was created. Null until then, and the claim that stops two servers launching it twice.';
comment on column public.tournament_matches.completed_at is
  'When the winner became known.';
comment on column public.tournament_matches.winner_player_id is
  'The player who advanced. Null until the match is decided.';
comment on column public.tournament_matches.loser_player_id is
  'The player who went out, for standings and for the third-place order.';
comment on column public.tournament_matches.is_walkover is
  'True when the match was decided by absence rather than by play.';
comment on column public.tournament_matches.points is
  'JSON of the score per seat, for example {"seat1": 25, "seat2": 18}. Used for round-robin point difference.';

create index if not exists tournament_matches_status_due_idx
  on public.tournament_matches (status, due_at);

create index if not exists tournament_matches_seat_1_player_id_idx
  on public.tournament_matches (seat_1_player_id);

create index if not exists tournament_matches_seat_2_player_id_idx
  on public.tournament_matches (seat_2_player_id);

-- ---------------------------------------------------------------------------
-- matches: who actually turned up
-- ---------------------------------------------------------------------------
alter table public.matches
  add column if not exists seat_1_joined_at timestamptz,
  add column if not exists seat_2_joined_at timestamptz;

comment on column public.matches.seat_1_joined_at is
  'When the player in seat 1 first connected to the room. Null means they never arrived, which is what a walkover is decided on.';
comment on column public.matches.seat_2_joined_at is
  'When the player in seat 2 first connected to the room. Null means they never arrived.';

-- ---------------------------------------------------------------------------
-- scheduler_leases: who is running the scheduler right now
-- ---------------------------------------------------------------------------
create table if not exists public.scheduler_leases (
  name text primary key,
  holder text not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint scheduler_leases_name_not_blank_check check (btrim(name) <> ''),
  constraint scheduler_leases_holder_not_blank_check check (btrim(holder) <> '')
);

comment on table public.scheduler_leases is
  'Leases held by scheduler instances. A lease that has expired may be taken over, which is how a crashed server stops blocking the job runner.';
comment on column public.scheduler_leases.name is
  'The job name, for example tournament_scheduler.';
comment on column public.scheduler_leases.holder is
  'An identifier for the instance holding the lease: hostname, pid and process start time.';
comment on column public.scheduler_leases.locked_until is
  'When the lease expires unless it is renewed.';

alter table public.scheduler_leases enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'scheduler_leases'
      and policyname = 'scheduler_leases_no_client_access'
  ) then
    -- Deliberately no policy: only the service role, which bypasses row level
    -- security, may read or write the leases.
    create policy scheduler_leases_no_client_access
      on public.scheduler_leases
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

create or replace function public.acquire_scheduler_lease(
  p_name text,
  p_holder text,
  p_lease_seconds integer,
  p_lock_key bigint
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_locked boolean;
  v_acquired boolean;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'acquire_scheduler_lease: name is required' using errcode = '22023';
  end if;

  if p_holder is null or btrim(p_holder) = '' then
    raise exception 'acquire_scheduler_lease: holder is required' using errcode = '22023';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 1 then
    raise exception 'acquire_scheduler_lease: lease_seconds must be at least 1'
      using errcode = '22023';
  end if;

  -- PostgREST hands every call its own connection, so a session-scoped advisory
  -- lock could not be held across the several calls a scheduler tick makes. A
  -- transaction-scoped lock is exactly right here: it makes the "is the lease
  -- free?" test and the "take it" write one atomic step, so two instances
  -- calling at the same instant cannot both believe they won. The lease row then
  -- carries ownership across the rest of the tick.
  v_locked := pg_try_advisory_xact_lock(p_lock_key);
  if not v_locked then
    return false;
  end if;

  insert into public.scheduler_leases as l (name, holder, locked_until)
  values (p_name, p_holder, now() + make_interval(secs => p_lease_seconds))
  on conflict (name) do update
    set holder = excluded.holder,
        locked_until = excluded.locked_until,
        updated_at = now()
    where l.locked_until <= now()
     or l.holder = excluded.holder
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end $$;

comment on function public.acquire_scheduler_lease(text, text, integer, bigint) is
  'Takes or renews a scheduler lease. True means this holder may run the job: it either took an expired lease, renewed its own, or won the race under the advisory lock.';

create or replace function public.release_scheduler_lease(
  p_name text,
  p_holder text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.scheduler_leases
     set locked_until = now(),
         updated_at = now()
   where name = p_name
     and holder = p_holder;

  return found;
end $$;

comment on function public.release_scheduler_lease(text, text) is
  'Gives a lease back before it expires, so the next instance does not wait for the timeout.';

commit;
