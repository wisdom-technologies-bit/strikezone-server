-- verify.sql
--
-- Behaviour checks for the migrations: ledger rules, append-only triggers, the
-- liability and bankroll views, row level security, the realtime publication and
-- comment coverage. It inserts its own fixture rows (two users, a finished match,
-- a live match, three markets and three bets), so run it against a scratch
-- database, never production.
--
-- Run it with supabase/tests/run.sh, which applies the shim and every migration
-- first. Every check prints PASS; any problem raises and stops the run.

\set ON_ERROR_STOP on
-- Deterministic fixture data, created as the owner (bypasses RLS).
create table if not exists ctx (k text primary key, v uuid);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test')
on conflict do nothing;

insert into profiles (id, username, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob', 'Bob')
on conflict do nothing;

insert into players (id, kind, profile_id, display_name) values
  ('33333333-3333-3333-3333-333333333333', 'human', '11111111-1111-1111-1111-111111111111', 'Alice P'),
  ('44444444-4444-4444-4444-444444444444', 'human', '22222222-2222-2222-2222-222222222222', 'Bob P')
on conflict do nothing;

insert into wallet_accounts (id, owner_type, user_id, currency) values
  ('55555555-5555-5555-5555-555555555555', 'user', '11111111-1111-1111-1111-111111111111', 'NGN'),
  ('66666666-6666-6666-6666-666666666666', 'user', '22222222-2222-2222-2222-222222222222', 'NGN')
on conflict do nothing;

insert into ctx values
  ('alice', '11111111-1111-1111-1111-111111111111'),
  ('bob', '22222222-2222-2222-2222-222222222222'),
  ('alice_acct', '55555555-5555-5555-5555-555555555555'),
  ('bob_acct', '66666666-6666-6666-6666-666666666666')
on conflict (k) do update set v = excluded.v;

-- Fund both players from the house: 1000.00 and 500.00 NGN in kobo.
select post_ledger_transaction(
  'fixture-deposit-alice', 'deposit', 'test', null,
  jsonb_build_array(
    jsonb_build_object('account_id', '55555555-5555-5555-5555-555555555555', 'amount_minor', 100000),
    jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN'), 'amount_minor', -100000)
  )
);
select post_ledger_transaction(
  'fixture-deposit-bob', 'deposit', 'test', null,
  jsonb_build_array(
    jsonb_build_object('account_id', '66666666-6666-6666-6666-666666666666', 'amount_minor', 50000),
    jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN'), 'amount_minor', -50000)
  )
);

-- A finished and a live match, with markets, bets and events.
insert into matches (id, game, status, seed_commit, seed_reveal, started_at, ended_at) values
  ('77777777-7777-7777-7777-777777777777', 'carrom', 'finished', 'commit', 'reveal', now() - interval '1 hour', now() - interval '50 minutes'),
  ('88888888-8888-8888-8888-888888888888', 'ludo', 'live', 'commit2', null, now() - interval '5 minutes', null)
on conflict do nothing;

insert into match_players (match_id, player_id, seat) values
  ('77777777-7777-7777-7777-777777777777', '33333333-3333-3333-3333-333333333333', 1),
  ('77777777-7777-7777-7777-777777777777', '44444444-4444-4444-4444-444444444444', 2),
  ('88888888-8888-8888-8888-888888888888', '33333333-3333-3333-3333-333333333333', 1)
on conflict do nothing;

insert into match_events (match_id, seq, type, prev_hash, hash) values
  ('77777777-7777-7777-7777-777777777777', 1, 'match_start', null, 'h1'),
  ('88888888-8888-8888-8888-888888888888', 1, 'match_start', null, 'h1')
on conflict do nothing;

insert into markets (id, match_id, market_type, subject, line, selection_key, fair_probability, odds_decimal, max_stake_minor) values
  ('99999999-9999-9999-9999-999999999991', '77777777-7777-7777-7777-777777777777', 'match_winner', '', null, 'alice', 0.6, 1.65, 50000),
  ('99999999-9999-9999-9999-999999999992', '77777777-7777-7777-7777-777777777777', 'match_winner', '', null, 'bob', 0.4, 2.45, 50000),
  ('99999999-9999-9999-9999-999999999993', '77777777-7777-7777-7777-777777777777', 'total_pockets', '', 12, 'over', 0.5, 1.95, 20000)
on conflict do nothing;

insert into bets (id, user_id, market_id, stake_minor, odds_locked, potential_payout_minor, status, idempotency_key) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999991', 10000, 1.65, 16500, 'open', 'bet-a-1'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '22222222-2222-2222-2222-222222222222', '99999999-9999-9999-9999-999999999992', 5000, 2.45, 12250, 'open', 'bet-b-1'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '22222222-2222-2222-2222-222222222222', '99999999-9999-9999-9999-999999999993', 2000, 1.95, 3900, 'open', 'bet-b-2')
on conflict do nothing;

\echo '--- 1. seed and constraints ---'
do $$
declare v_bots int; v_accounts int; v_bot_flag boolean;
begin
  select count(*) into v_bots from players where kind = 'bot';
  select count(*) into v_accounts from wallet_accounts where owner_type in ('house','escrow');
  select bool_and(is_bot) into v_bot_flag from players where kind = 'bot';
  if v_bots <> 6 then raise exception 'FAIL: expected 6 seeded bots, found %', v_bots; end if;
  if v_accounts <> 2 then raise exception 'FAIL: expected house and escrow, found %', v_accounts; end if;
  if not v_bot_flag then raise exception 'FAIL: a bot row has is_bot false'; end if;
  raise notice 'PASS: 6 bots (all labelled is_bot) plus house and escrow accounts';
end $$;

do $$
begin
  begin
    insert into wallet_accounts (owner_type, currency) values ('house', 'NGN');
    raise exception 'FAIL: a second house account was accepted';
  exception when unique_violation then
    raise notice 'PASS: a second house account per currency is refused';
  end;
end $$;

\echo '--- 2. ledger behaviour ---'
do $$
declare v_alice bigint; v_house bigint; v_sum bigint;
begin
  select balance_minor into v_alice from account_balances where account_id = (select v from ctx where k = 'alice_acct');
  select balance_minor into v_house from account_balances where account_id = (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN');
  select sum(amount_minor) into v_sum from ledger_entries
    where transaction_id = (select id from ledger_transactions where idempotency_key = 'fixture-deposit-alice');
  if v_alice <> 100000 then raise exception 'FAIL: alice balance %, expected 100000', v_alice; end if;
  if v_house <> -150000 then raise exception 'FAIL: house balance %, expected -150000', v_house; end if;
  if v_sum <> 0 then raise exception 'FAIL: deposit legs sum to %', v_sum; end if;
  raise notice 'PASS: deposit moved 100000 kobo, legs sum to zero, derived balance correct';
end $$;

do $$
declare v_before int; v_after int;
begin
  select count(*) into v_before from ledger_transactions;
  begin
    perform post_ledger_transaction('unbalanced-1', 'adjustment', null, null,
      jsonb_build_array(jsonb_build_object('account_id', (select v from ctx where k = 'alice_acct'), 'amount_minor', 100)));
    raise exception 'FAIL: an unbalanced transaction was accepted';
  exception when check_violation then
    null;
  end;
  select count(*) into v_after from ledger_transactions;
  if v_before <> v_after then raise exception 'FAIL: a rejected transaction left rows behind'; end if;
  raise notice 'PASS: legs that do not sum to zero are refused, nothing is written';
end $$;

do $$
begin
  begin
    perform post_ledger_transaction('overdraft-alice', 'bet_stake', 'bet', null,
      jsonb_build_array(
        jsonb_build_object('account_id', (select v from ctx where k = 'alice_acct'), 'amount_minor', -100001),
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'escrow' and currency = 'NGN'), 'amount_minor', 100001)
      ));
    raise exception 'FAIL: an overdraft was accepted';
  exception when check_violation then
    raise notice 'PASS: an overdraw on a user account is refused';
  end;

  begin
    perform post_ledger_transaction('fractional-1', 'adjustment', null, null,
      jsonb_build_array(
        jsonb_build_object('account_id', (select v from ctx where k = 'alice_acct'), 'amount_minor', 1.5),
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN'), 'amount_minor', -1.5)
      ));
    raise exception 'FAIL: a fractional amount was accepted';
  exception when invalid_parameter_value then
    raise notice 'PASS: a fractional amount_minor is refused';
  end;

  begin
    perform post_ledger_transaction('zero-1', 'adjustment', null, null,
      jsonb_build_array(
        jsonb_build_object('account_id', (select v from ctx where k = 'alice_acct'), 'amount_minor', 0),
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN'), 'amount_minor', 0)
      ));
    raise exception 'FAIL: a zero entry was accepted';
  exception when invalid_parameter_value then
    raise notice 'PASS: a zero entry is refused';
  end;

  begin
    perform post_ledger_transaction('unknown-field-1', 'adjustment', null, null,
      jsonb_build_array(
        jsonb_build_object('account_id', (select v from ctx where k = 'alice_acct'), 'amount_minor', 10, 'memo', 'x'),
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN'), 'amount_minor', -10)
      ));
    raise exception 'FAIL: an unknown entry field was accepted';
  exception when invalid_parameter_value then
    raise notice 'PASS: an unknown entry field is refused';
  end;

  begin
    perform post_ledger_transaction('bad-kind-1', 'free_money', null, null,
      jsonb_build_array(
        jsonb_build_object('account_id', (select v from ctx where k = 'alice_acct'), 'amount_minor', 10),
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN'), 'amount_minor', -10)
      ));
    raise exception 'FAIL: an unknown kind was accepted';
  exception when invalid_parameter_value then
    raise notice 'PASS: an unknown transaction kind is refused';
  end;

  begin
    perform post_ledger_transaction('unknown-account-1', 'adjustment', null, null,
      jsonb_build_array(
        jsonb_build_object('account_id', '00000000-0000-0000-0000-000000000000', 'amount_minor', 10),
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN'), 'amount_minor', -10)
      ));
    raise exception 'FAIL: an unknown account was accepted';
  exception when foreign_key_violation then
    raise notice 'PASS: an unknown account is refused';
  end;
end $$;

do $$
declare v_first ledger_transactions; v_second ledger_transactions; v_count int; v_balance bigint;
begin
  v_first := post_ledger_transaction('idem-1', 'bet_stake', 'bet', null,
    jsonb_build_array(
      jsonb_build_object('account_id', (select v from ctx where k = 'alice_acct'), 'amount_minor', -1000),
      jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'escrow' and currency = 'NGN'), 'amount_minor', 1000)
    ));
  v_second := post_ledger_transaction('idem-1', 'bet_stake', 'bet', null,
    jsonb_build_array(
      jsonb_build_object('account_id', (select v from ctx where k = 'alice_acct'), 'amount_minor', -1000),
      jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'escrow' and currency = 'NGN'), 'amount_minor', 1000)
    ));
  if v_first.id <> v_second.id then raise exception 'FAIL: replay returned a different transaction'; end if;
  select count(*) into v_count from ledger_transactions where idempotency_key = 'idem-1';
  select balance_minor into v_balance from account_balances where account_id = (select v from ctx where k = 'alice_acct');
  if v_count <> 1 then raise exception 'FAIL: replay created % transactions', v_count; end if;
  if v_balance <> 99000 then raise exception 'FAIL: replay moved money again, balance %', v_balance; end if;
  raise notice 'PASS: a repeated idempotency key returns the original transaction and moves no money';
end $$;

do $$
begin
  begin
    update ledger_transactions set kind = 'adjustment' where idempotency_key = 'idem-1';
    raise exception 'FAIL: ledger_transactions UPDATE was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on ledger_transactions is blocked';
  end;

  begin
    delete from ledger_entries where true;
    raise exception 'FAIL: ledger_entries DELETE was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS: DELETE on ledger_entries is blocked';
  end;

  begin
    update match_events set type = 'tampered' where true;
    raise exception 'FAIL: match_events UPDATE was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS: UPDATE on match_events is blocked';
  end;
end $$;

\echo '--- 3. views ---'
do $$
declare v_expected bigint; v_actual bigint; v_house bigint; v_free bigint; v_currency text;
begin
  -- Worst case: alice 16500, bob 12250 and 3900. Per match the dearest market is
  -- alice 16500 (match_winner) plus 3900 (total_pockets over 12).
  v_expected := 16500 + 3900;
  select liability_minor into v_actual from open_liability where match_id = '77777777-7777-7777-7777-777777777777';
  if v_actual <> v_expected then raise exception 'FAIL: open liability % , expected %', v_actual, v_expected; end if;
  raise notice 'PASS: open_liability is % kobo for the match (dearest selection per market)', v_actual;

  select currency, balance_minor, free_minor into v_currency, v_house, v_free from house_bankroll;
  if v_currency <> 'NGN' then raise exception 'FAIL: house_bankroll currency %', v_currency; end if;
  if v_house <> -150000 then raise exception 'FAIL: house balance %, expected -150000 (both deposits paid out)', v_house; end if;
  if v_free <> v_house - 20400 then raise exception 'FAIL: free_minor % does not equal balance minus liability', v_free; end if;
  raise notice 'PASS: house_bankroll reports balance %, liability 20400, free %', v_house, v_free;
end $$;

\echo '--- 4. row level security ---'
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare v_names text; v_accounts int; v_entries int; v_bets int; v_players int; v_markets int; v_events int; v_tx int;
begin
  select string_agg(username, ',') into v_names from profiles;
  if v_names <> 'alice' then raise exception 'FAIL: alice can read profiles %', v_names; end if;
  select count(*) into v_accounts from wallet_accounts;
  if v_accounts <> 1 then raise exception 'FAIL: alice sees % wallet accounts', v_accounts; end if;
  select count(*) into v_bets from bets;
  if v_bets <> 1 then raise exception 'FAIL: alice sees % bets', v_bets; end if;
  select count(*) into v_entries from ledger_entries;
  select count(*) into v_players from players;
  select count(*) into v_markets from markets;
  select count(*) into v_events from match_events;
  begin
    select count(*) into v_tx from ledger_transactions;
  exception when insufficient_privilege then
    v_tx := 0;
  end;
  if v_players < 8 then raise exception 'FAIL: alice sees only % players, expected the public list', v_players; end if;
  if v_markets <> 3 then raise exception 'FAIL: alice sees % markets, expected 3', v_markets; end if;
  if v_events <> 1 then raise exception 'FAIL: alice sees % match events, expected only the finished match', v_events; end if;
  if v_tx <> 0 then raise exception 'FAIL: alice can read % ledger transaction headers', v_tx; end if;
  if v_entries < 1 then raise exception 'FAIL: alice sees none of her own ledger entries'; end if;
  raise notice 'PASS: authenticated user sees own profile, one wallet, own bets, % entries, public list, finished match events only, no transaction headers', v_entries;
end $$;

do $$
begin
  begin
    insert into bets (user_id, market_id, stake_minor, odds_locked, potential_payout_minor, idempotency_key)
    values ('11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999992', 100, 2.45, 245, 'browser-write');
    raise exception 'FAIL: a browser insert into bets was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS: browser insert into bets is refused';
  end;

  begin
    perform post_ledger_transaction('browser-money', 'adjustment', null, null, '[]'::jsonb);
    raise exception 'FAIL: a browser could call post_ledger_transaction';
  exception when insufficient_privilege then
    raise notice 'PASS: browser cannot execute post_ledger_transaction';
  end;

  begin
    select count(*) from open_liability;
    raise exception 'FAIL: a browser can read open_liability';
  exception when insufficient_privilege then
    raise notice 'PASS: house liability view is not readable by browsers';
  end;
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

set role anon;
do $$
declare v_profiles int; v_players int; v_events int; v_wallets int;
begin
  select count(*) into v_players from players;
  select count(*) into v_events from match_events;
  if v_players < 8 then raise exception 'FAIL: anon sees % players', v_players; end if;
  if v_events <> 1 then raise exception 'FAIL: anon sees % match events', v_events; end if;
  begin
    select count(*) into v_profiles from profiles;
    if v_profiles <> 0 then raise exception 'FAIL: anon can read profiles'; end if;
  exception when insufficient_privilege then
    null;
  end;
  begin
    select count(*) into v_wallets from wallet_accounts;
    if v_wallets <> 0 then raise exception 'FAIL: anon can read wallet accounts'; end if;
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'PASS: anonymous visitor reads players and finished match events, no profiles and no wallets';
end $$;
reset role;

\echo '--- 5. realtime publication ---'
do $$
declare v_tables text;
begin
  select string_agg(tablename, ',' order by tablename) into v_tables
  from pg_publication_tables where pubname = 'supabase_realtime';
  if v_tables is distinct from 'bets,markets,matches,tournament_matches' then
    raise exception 'FAIL: publication contains %', coalesce(v_tables, '(nothing)');
  end if;
  raise notice 'PASS: realtime publication carries %', v_tables;
end $$;


\echo '--- 6. tournament lifecycle ---'
do $$
declare
  v_tournament uuid;
  v_pool uuid;
  v_ok boolean;
  v_status text;
begin
  insert into tournaments (game, name, format, entry_fee_minor, min_players, max_players, currency)
  values ('carrom', 'Verify Cup', 'single_elimination', 1000, 4, 8, 'NGN')
  returning id into v_tournament;

  -- A prize pool must name its tournament, and only one may exist per tournament.
  begin
    insert into wallet_accounts (owner_type, currency) values ('prize_pool', 'NGN');
    raise exception 'FAIL: a prize pool without a tournament was accepted';
  exception when check_violation then
    null;
  end;

  insert into wallet_accounts (owner_type, currency, tournament_id)
  values ('prize_pool', 'NGN', v_tournament)
  returning id into v_pool;

  begin
    insert into wallet_accounts (owner_type, currency, tournament_id)
    values ('prize_pool', 'NGN', v_tournament);
    raise exception 'FAIL: a second prize pool for the same tournament was accepted';
  exception when unique_violation then
    null;
  end;

  -- A bracket position starts pending and refuses an unknown status.
  insert into tournament_matches (tournament_id, round, slot, winner_to_slot)
  values (v_tournament, 1, 1, 1)
  returning status into v_status;
  if v_status <> 'pending' then
    raise exception 'FAIL: a new bracket position is %', v_status;
  end if;

  begin
    update tournament_matches set status = 'impossible' where tournament_id = v_tournament;
    raise exception 'FAIL: an unknown bracket status was accepted';
  exception when check_violation then
    null;
  end;

  -- The registration window must run forwards.
  begin
    update tournaments
       set registration_opens_at = now(),
           registration_closes_at = now() - interval '1 hour'
     where id = v_tournament;
    raise exception 'FAIL: a backwards registration window was accepted';
  exception when check_violation then
    null;
  end;

  -- The scheduler lease: one holder at a time, and only until it expires.
  v_ok := acquire_scheduler_lease('verify_job', 'instance-a', 60, 918273);
  if not v_ok then
    raise exception 'FAIL: the first lease attempt was refused';
  end if;

  v_ok := acquire_scheduler_lease('verify_job', 'instance-b', 60, 918273);
  if v_ok then
    raise exception 'FAIL: a second instance took a live lease';
  end if;

  -- A lease that has expired may be taken over, which is how a crash recovers.
  update scheduler_leases set locked_until = now() - interval '1 second' where name = 'verify_job';
  v_ok := acquire_scheduler_lease('verify_job', 'instance-b', 60, 918273);
  if not v_ok then
    raise exception 'FAIL: an expired lease was not taken over';
  end if;

  -- The same holder may renew, and releasing frees it immediately.
  v_ok := acquire_scheduler_lease('verify_job', 'instance-b', 60, 918273);
  if not v_ok then
    raise exception 'FAIL: a holder could not renew its own lease';
  end if;

  if not release_scheduler_lease('verify_job', 'instance-b') then
    raise exception 'FAIL: releasing a held lease reported nothing released';
  end if;

  v_ok := acquire_scheduler_lease('verify_job', 'instance-a', 60, 918273);
  if not v_ok then
    raise exception 'FAIL: a released lease could not be taken';
  end if;

  -- A withdrawal keeps the row and its ledger trail.
  insert into tournament_entries (tournament_id, player_id, seed, status)
  values (v_tournament, '33333333-3333-3333-3333-333333333333', 1, 'registered');
  update tournament_entries set status = 'withdrawn', withdrawn_at = now()
   where tournament_id = v_tournament;
  if not found then
    raise exception 'FAIL: an entry could not be marked withdrawn';
  end if;

  raise notice 'PASS: prize pools, bracket status, registration window and scheduler lease behave';
end $$;

\echo '--- 7. documentation coverage ---'
do $$
declare v_missing text;
begin
  select string_agg(c.relname, ',') into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'v', 'p')
    and c.relname <> 'ctx' -- helper table owned by this test script
    and obj_description(c.oid, 'pg_class') is null;
  if v_missing is not null then
    raise exception 'FAIL: tables or views without a comment: %', v_missing;
  end if;

  select string_agg(p.proname, ',') into v_missing
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and obj_description(p.oid, 'pg_proc') is null;
  if v_missing is not null then
    raise exception 'FAIL: functions without a comment: %', v_missing;
  end if;
  raise notice 'PASS: every public table, view and function carries a comment';
end $$;

\echo 'ALL CHECKS PASSED'
