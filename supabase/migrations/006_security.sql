-- 006_security.sql
--
-- Row level security, browser-facing read policies, realtime publication and
-- table privileges.
--
-- Model: the browser never writes. The server holds the service role key, which
-- bypasses row level security, and every write goes through it. So there is no
-- INSERT, UPDATE or DELETE policy anywhere in this file, and write privileges
-- are revoked from anon and authenticated as well, belt and braces.
--
-- Uses auth.uid() from Supabase Auth: these statements assume the standard
-- Supabase roles (anon, authenticated, service_role) exist.

begin;

-- ---------------------------------------------------------------------------
-- Enable row level security on every table. Default deny: no policy means no
-- access for browser roles.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.players enable row level security;
alter table public.wallet_accounts enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
alter table public.match_events enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_entries enable row level security;
alter table public.tournament_matches enable row level security;
alter table public.markets enable row level security;
alter table public.bets enable row level security;

-- ---------------------------------------------------------------------------
-- Own-data policies: a signed-in user reads only rows that belong to them
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists wallet_accounts_select_own on public.wallet_accounts;
create policy wallet_accounts_select_own on public.wallet_accounts
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists ledger_entries_select_own on public.ledger_entries;
create policy ledger_entries_select_own on public.ledger_entries
  for select to authenticated
  using (
    exists (
      select 1
      from public.wallet_accounts wa
      where wa.id = ledger_entries.account_id
        and wa.user_id = (select auth.uid())
    )
  );

drop policy if exists bets_select_own on public.bets;
create policy bets_select_own on public.bets
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Public-read policies: the site's public pages and live match view
-- ---------------------------------------------------------------------------
drop policy if exists players_select_public on public.players;
create policy players_select_public on public.players
  for select to anon, authenticated
  using (true);

drop policy if exists matches_select_public on public.matches;
create policy matches_select_public on public.matches
  for select to anon, authenticated
  using (true);

drop policy if exists match_players_select_public on public.match_players;
create policy match_players_select_public on public.match_players
  for select to anon, authenticated
  using (true);

drop policy if exists tournaments_select_public on public.tournaments;
create policy tournaments_select_public on public.tournaments
  for select to anon, authenticated
  using (true);

drop policy if exists tournament_entries_select_public on public.tournament_entries;
create policy tournament_entries_select_public on public.tournament_entries
  for select to anon, authenticated
  using (true);

drop policy if exists tournament_matches_select_public on public.tournament_matches;
create policy tournament_matches_select_public on public.tournament_matches
  for select to anon, authenticated
  using (true);

drop policy if exists markets_select_public on public.markets;
create policy markets_select_public on public.markets
  for select to anon, authenticated
  using (true);

-- The event log of a live match stays secret: it would leak the seed outcome and
-- the current board. Only finished matches are public.
drop policy if exists match_events_select_finished on public.match_events;
create policy match_events_select_finished on public.match_events
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.matches m
      where m.id = match_events.match_id
        and m.status = 'finished'
    )
  );

-- ledger_transactions has no policy on purpose: transaction headers are
-- server-side only. Users see their own movement through ledger_entries.

-- ---------------------------------------------------------------------------
-- Table and view privileges
-- ---------------------------------------------------------------------------
-- No browser writes anywhere.
revoke insert, update, delete, truncate on
  public.profiles,
  public.players,
  public.wallet_accounts,
  public.ledger_transactions,
  public.ledger_entries,
  public.matches,
  public.match_players,
  public.match_events,
  public.tournaments,
  public.tournament_entries,
  public.tournament_matches,
  public.markets,
  public.bets
from anon, authenticated;

-- Reads are still filtered by the policies above, so this only opens the door
-- where a policy exists.
grant select on
  public.profiles,
  public.players,
  public.wallet_accounts,
  public.ledger_entries,
  public.matches,
  public.match_players,
  public.match_events,
  public.tournaments,
  public.tournament_entries,
  public.tournament_matches,
  public.markets,
  public.bets
to authenticated;

grant select on
  public.players,
  public.matches,
  public.match_players,
  public.match_events,
  public.tournaments,
  public.tournament_entries,
  public.tournament_matches,
  public.markets
to anon;

-- A player's own balance is readable: account_balances runs with the caller's
-- privileges, so only accounts the caller may read contribute.
grant select on public.account_balances to authenticated;

-- House solvency views are server-side reporting only.
revoke all on public.open_liability from anon, authenticated;
revoke all on public.house_bankroll from anon, authenticated;

-- The ledger posting function is a service-role privilege: a browser must never
-- be able to move money, even with a policy bypass available.
revoke all on function public.post_ledger_transaction(text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.post_ledger_transaction(text, text, text, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Realtime: the site subscribes to these tables for live prices and results
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_missing text[] := array[]::text[];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise warning
      'publication supabase_realtime does not exist: skipping realtime setup. On Supabase it is created for you.';
    return;
  end if;

  foreach v_table in array array['markets', 'matches', 'tournament_matches', 'bets'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      begin
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      exception when insufficient_privilege then
        v_missing := v_missing || v_table;
      end;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise warning
      'could not add % to publication supabase_realtime: run this file as a role that owns the publication',
      array_to_string(v_missing, ', ');
  end if;
end $$;

commit;
