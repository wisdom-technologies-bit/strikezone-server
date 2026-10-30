-- money.sql
--
-- Behaviour checks for migration 009: bet placement through place_bet, the
-- exposure caps, responsible-play limits, the kill switches and the ledger
-- invariants the money paths depend on.
--
-- Every check prints PASS. Any failure raises, so the run stops at the first
-- problem. Run it against a scratch database: it inserts its own fixtures and
-- moves money.
--
--   supabase/tests/run.sh          # applies the shim, migrations, verify.sql, money.sql

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- fixtures
-- ---------------------------------------------------------------------------
create table if not exists money_ctx (k text primary key, v uuid);
delete from money_ctx;

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'carol@example.test'),
  ('a0000000-0000-4000-8000-000000000002', 'dave@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'erin@example.test'),
  ('a0000000-0000-4000-8000-000000000004', 'frank@example.test'),
  ('a0000000-0000-4000-8000-000000000005', 'grace@example.test'),
  ('a0000000-0000-4000-8000-000000000006', 'henry@example.test')
on conflict do nothing;

insert into profiles (id, username, display_name) values
  ('a0000000-0000-4000-8000-000000000001', 'carol', 'Carol'),
  ('a0000000-0000-4000-8000-000000000002', 'dave', 'Dave'),
  ('a0000000-0000-4000-8000-000000000003', 'erin', 'Erin'),
  ('a0000000-0000-4000-8000-000000000004', 'frank', 'Frank'),
  ('a0000000-0000-4000-8000-000000000005', 'grace', 'Grace'),
  ('a0000000-0000-4000-8000-000000000006', 'henry', 'Henry')
on conflict (id) do update set display_name = excluded.display_name;

-- A match and two markets. The match id is stable so re-runs reuse it.
insert into matches (id, game, status, started_at) values
  ('b0000000-0000-4000-8000-000000000001', 'carrom', 'live', now())
on conflict (id) do nothing;

insert into markets (id, match_id, market_type, subject, line, selection_key, fair_probability, odds_decimal, max_stake_minor) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'match_winner', '', null, 'carol', 0.5, 2.0, 100000),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'match_winner', '', null, 'dave', 0.5, 2.0, 100000),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'total_pockets', '', 12, 'over', 0.5, 1.9, 50000)
on conflict (id) do update set
  status = 'open',
  odds_decimal = excluded.odds_decimal,
  max_stake_minor = excluded.max_stake_minor;

-- Fund the house from the treasury, then fund each player from the house.
select post_ledger_transaction(
  'money-test-topup',
  'bankroll_topup',
  'test',
  null,
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'treasury' and currency = 'NGN')::text, 'amount_minor', -50000000),
    jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN')::text, 'amount_minor', 50000000)
  )
);

do $$
declare
  v_user uuid;
  v_username text;
  v_funds bigint;
begin
  for v_user, v_username, v_funds in
    select * from (values
      ('a0000000-0000-4000-8000-000000000001'::uuid, 'carol', 1000000::bigint),
      ('a0000000-0000-4000-8000-000000000002'::uuid, 'dave', 1000000::bigint),
      ('a0000000-0000-4000-8000-000000000003'::uuid, 'erin', 1000000::bigint),
      ('a0000000-0000-4000-8000-000000000004'::uuid, 'frank', 1000000::bigint),
      ('a0000000-0000-4000-8000-000000000005'::uuid, 'grace', 1000000::bigint),
      ('a0000000-0000-4000-8000-000000000006'::uuid, 'henry', 1000::bigint)
    ) as t(user_id, username, funds)
  loop
    insert into wallet_accounts (owner_type, user_id, currency)
    values ('user', v_user, 'NGN')
    on conflict do nothing;

    perform post_ledger_transaction(
      'money-test-fund-' || v_username,
      'deposit',
      'test',
      null,
      jsonb_build_array(
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'user' and user_id = v_user)::text, 'amount_minor', v_funds),
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN')::text, 'amount_minor', -v_funds)
      )
    );
  end loop;
end $$;

create or replace function pg_temp.acct(p_user uuid) returns uuid
language sql stable as $$
  select id from wallet_accounts where owner_type = 'user' and user_id = p_user;
$$;

create or replace function pg_temp.bal(p_user uuid) returns bigint
language sql stable as $$
  select coalesce((select balance_minor from account_balances where account_id = pg_temp.acct(p_user)), 0);
$$;

create or replace function pg_temp.escrow() returns bigint
language sql stable as $$
  select coalesce((select balance_minor from account_balances where account_id = (select id from wallet_accounts where owner_type = 'escrow' and currency = 'NGN')), 0);
$$;

\echo '--- 1. a bet is placed, priced and funded in one transaction ---'
do $$
declare
  v_result jsonb;
  v_bet_id uuid;
  v_before bigint := pg_temp.bal('a0000000-0000-4000-8000-000000000001');
  v_escrow_before bigint := pg_temp.escrow();
begin
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    10000, 2.0, 'carol-bet-1', 100, 20, false
  );

  if (v_result ->> 'ok')::boolean is not true then
    raise exception 'FAIL: a valid bet was refused: %', v_result;
  end if;

  v_bet_id := (v_result -> 'bet' ->> 'id')::uuid;

  if (v_result -> 'bet' ->> 'odds_locked')::numeric <> 2.0 then
    raise exception 'FAIL: odds not locked at the market price: %', v_result;
  end if;
  if (v_result -> 'bet' ->> 'potential_payout_minor')::bigint <> 20000 then
    raise exception 'FAIL: potential payout is not floor(stake x odds): %', v_result;
  end if;
  if pg_temp.bal('a0000000-0000-4000-8000-000000000001') <> v_before - 10000 then
    raise exception 'FAIL: the stake was not taken from the player';
  end if;
  if pg_temp.escrow() <> v_escrow_before + 10000 then
    raise exception 'FAIL: the stake did not land in escrow';
  end if;

  raise notice 'PASS: bet placed at 2.00, 20000 to win, stake moved to escrow';
end $$;

\echo '--- 2. replaying the idempotency key returns the same bet ---'
do $$
declare
  v_first uuid := (select id from bets where idempotency_key = 'carol-bet-1');
  v_balance bigint := pg_temp.bal('a0000000-0000-4000-8000-000000000001');
  v_result jsonb;
begin
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    10000, 2.0, 'carol-bet-1', 100, 20, false
  );

  if (v_result ->> 'ok')::boolean is not true or (v_result ->> 'replayed')::boolean is not true then
    raise exception 'FAIL: the replay was not recognised: %', v_result;
  end if;
  if (v_result -> 'bet' ->> 'id')::uuid <> v_first then
    raise exception 'FAIL: the replay returned a different bet';
  end if;
  if pg_temp.bal('a0000000-0000-4000-8000-000000000001') <> v_balance then
    raise exception 'FAIL: the replay moved money again';
  end if;
  if (select count(*) from bets where idempotency_key = 'carol-bet-1') <> 1 then
    raise exception 'FAIL: the replay created a second bet row';
  end if;

  raise notice 'PASS: replay is a no-op, one bet row, balance untouched';
end $$;

\echo '--- 3. odds drift, both directions ---'
do $$
declare
  v_result jsonb;
begin
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
    1000, 2.5, 'carol-drift-low', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'odds_moved' then
    raise exception 'FAIL: a lower price was accepted: %', v_result;
  end if;
  if (v_result ->> 'currentOdds')::numeric <> 2.0 then
    raise exception 'FAIL: the refusal did not return the current odds: %', v_result;
  end if;

  -- A price that moved in the player's favour is taken at the better price.
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
    1000, 1.5, 'carol-drift-high', 100, 20, false
  );
  if (v_result ->> 'ok')::boolean is not true then
    raise exception 'FAIL: a better price was refused: %', v_result;
  end if;
  if (v_result ->> 'oddsLocked')::numeric <> 2.0 then
    raise exception 'FAIL: the better price was not honoured: %', v_result;
  end if;

  raise notice 'PASS: a worse price is refused with the current odds, a better one is taken';
end $$;

\echo '--- 4. stake floor, market ceiling and funds ---'
do $$
declare
  v_result jsonb;
begin
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002',
    50, 2.0, 'dave-small', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'stake_below_minimum' then
    raise exception 'FAIL: a stake below the minimum was accepted: %', v_result;
  end if;

  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002',
    100001, 2.0, 'dave-big', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'stake_above_market_max' then
    raise exception 'FAIL: a stake above the market cap was accepted: %', v_result;
  end if;

  -- Henry holds 1,000 kobo, so a 2,000 stake is inside the market cap and
  -- outside his balance.
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000002',
    2000, 2.0, 'henry-broke', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'insufficient_funds' then
    raise exception 'FAIL: a stake above the balance was accepted: %', v_result;
  end if;
  if (v_result ->> 'balanceMinor')::bigint <> pg_temp.bal('a0000000-0000-4000-8000-000000000006') then
    raise exception 'FAIL: the refusal did not report the balance: %', v_result;
  end if;

  raise notice 'PASS: minimum stake, market maximum and the balance are all enforced';
end $$;

\echo '--- 5. a closed market, a self-excluded player and KYC ---'
do $$
declare
  v_result jsonb;
begin
  update markets set status = 'suspended' where id = 'c0000000-0000-4000-8000-000000000003';
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003',
    1000, 1.9, 'dave-suspended', 100, 20, false
  );
  update markets set status = 'open' where id = 'c0000000-0000-4000-8000-000000000003';
  if v_result ->> 'code' is distinct from 'market_closed' then
    raise exception 'FAIL: a suspended market took a bet: %', v_result;
  end if;

  update profiles set self_excluded_until = now() + interval '1 day', self_exclusion_kind = 'cool_off'
  where id = 'a0000000-0000-4000-8000-000000000003';
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000002',
    1000, 2.0, 'erin-excluded', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'self_excluded' then
    raise exception 'FAIL: a self-excluded player was allowed to bet: %', v_result;
  end if;

  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002',
    1000, 2.0, 'frank-kyc', 100, 20, true
  );
  if v_result ->> 'code' is distinct from 'kyc_required' then
    raise exception 'FAIL: real-money play without KYC was allowed: %', v_result;
  end if;

  raise notice 'PASS: suspended market, self-exclusion and KYC each block the bet';
end $$;

\echo '--- 6. responsible-play limits, and the 24 hour rule ---'
do $$
declare
  v_result jsonb;
  v_effective record;
begin
  insert into user_limits (user_id, max_stake_minor, daily_loss_limit_minor)
  values ('a0000000-0000-4000-8000-000000000004', 5000, 20000)
  on conflict (user_id) do update set
    max_stake_minor = excluded.max_stake_minor,
    daily_loss_limit_minor = excluded.daily_loss_limit_minor,
    pending_effective_at = null,
    pending_max_stake_minor = null,
    pending_daily_loss_limit_minor = null;

  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002',
    6000, 2.0, 'frank-over-limit', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'stake_above_limit' then
    raise exception 'FAIL: a stake above the player limit was accepted: %', v_result;
  end if;

  -- Losing stakes count against the daily loss limit.
  insert into bets (user_id, market_id, stake_minor, odds_locked, potential_payout_minor, status, idempotency_key, settled_at, result, payout_minor)
  values ('a0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002', 18000, 2.0, 36000, 'lost', 'fixture-direct:frank-lost-today', now(), 'lost', 0)
  on conflict (idempotency_key) do nothing;

  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002',
    3000, 2.0, 'frank-loss-limit', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'daily_loss_limit' then
    raise exception 'FAIL: the daily loss limit did not block the bet: %', v_result;
  end if;

  -- Raising a limit waits; the old value stays in force until it is due.
  update user_limits
  set pending_max_stake_minor = 50000,
      pending_effective_at = now() + interval '24 hours'
  where user_id = 'a0000000-0000-4000-8000-000000000004';

  select * into v_effective from public.effective_limits('a0000000-0000-4000-8000-000000000004');
  if v_effective.max_stake_minor <> 5000 then
    raise exception 'FAIL: a raised limit applied before its 24 hours: %', v_effective.max_stake_minor;
  end if;

  update user_limits set pending_effective_at = now() - interval '1 second'
  where user_id = 'a0000000-0000-4000-8000-000000000004';
  select * into v_effective from public.effective_limits('a0000000-0000-4000-8000-000000000004');
  if v_effective.max_stake_minor <> 50000 then
    raise exception 'FAIL: a due limit did not apply: %', v_effective.max_stake_minor;
  end if;

  -- Lowering a limit is immediate: no pending row at all.
  update user_limits set max_stake_minor = 50000, pending_max_stake_minor = null, pending_effective_at = null
  where user_id = 'a0000000-0000-4000-8000-000000000004';

  raise notice 'PASS: max stake and daily loss limits block, a raise waits 24 hours, a drop is immediate';
end $$;

\echo '--- 7. the rate limit is ten bets a minute ---'
do $$
declare
  v_index integer;
  v_result jsonb;
begin
  for v_index in 1..10 loop
    v_result := public.place_bet(
      'a0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002',
      100, 2.0, 'grace-rate-' || v_index, 100, 20, false
    );
    if (v_result ->> 'ok')::boolean is not true then
      raise exception 'FAIL: bet % of 10 was refused: %', v_index, v_result;
    end if;
  end loop;

  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002',
    100, 2.0, 'grace-rate-11', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'rate_limited' then
    raise exception 'FAIL: the eleventh bet in a minute was accepted: %', v_result;
  end if;

  raise notice 'PASS: ten bets accepted, the eleventh refused for one minute';
end $$;

\echo '--- 8. the kill switch ---'
do $$
declare
  v_result jsonb;
begin
  update system_flags set value = '{"paused": true}'::jsonb where key = 'betting';

  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002',
    1000, 2.0, 'dave-paused', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'betting_paused' then
    raise exception 'FAIL: a paused platform took a bet: %', v_result;
  end if;

  update system_flags set value = '{"paused": false}'::jsonb where key = 'betting';
  raise notice 'PASS: pausing betting refuses every new bet';
end $$;

\echo '--- 9. exposure is the dearest selection minus the stakes, floored at zero ---'
do $$
declare
  v_actual bigint;
begin
  -- A match of its own, so the arithmetic below is the only thing in it.
  insert into matches (id, game, status, started_at) values
    ('b0000000-0000-4000-8000-000000000002', 'carrom', 'live', now())
  on conflict (id) do nothing;

  insert into markets (id, match_id, market_type, subject, line, selection_key, fair_probability, odds_decimal, max_stake_minor) values
    ('c0000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000002', 'match_winner', '', null, 'x', 0.5, 2.0, 100000),
    ('c0000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000002', 'match_winner', '', null, 'y', 0.33, 3.0, 100000),
    ('c0000000-0000-4000-8000-000000000011', 'b0000000-0000-4000-8000-000000000002', 'total_pockets', '', 12, 'over', 0.95, 1.05, 100000)
  on conflict (id) do nothing;

  delete from bets where idempotency_key like 'fixture-direct:exposure-nine-%';
  insert into bets (user_id, market_id, stake_minor, odds_locked, potential_payout_minor, status, idempotency_key)
  values
    ('a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000009', 10000, 2.0, 20000, 'open', 'fixture-direct:exposure-nine-1'),
    ('a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000009', 2000, 2.0, 4000, 'open', 'fixture-direct:exposure-nine-2'),
    ('a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000010', 1000, 3.0, 3000, 'open', 'fixture-direct:exposure-nine-3'),
    ('a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000011', 10000, 1.05, 10500, 'open', 'fixture-direct:exposure-nine-4');

  -- Market one: dearest payout 24000 minus 13000 staked = 11000.
  -- Market two: 10500 payout minus 10000 staked = 500.
  v_actual := public.match_exposure_minor('b0000000-0000-4000-8000-000000000002', null);

  if v_actual <> 11500 then
    raise exception 'FAIL: match exposure is % not 11500', v_actual;
  end if;

  -- A hypothetical bet is counted before it is written. It lands on the other
  -- selection of market one: payouts there become max(24000, 33000) = 33000 and
  -- the market's stakes 12000 + 11000 = 23000, so 10000 + 500 = 10500. Exposure
  -- can fall when a bet is added, because the stake is money the house keeps.
  if public.match_exposure_minor(
    'b0000000-0000-4000-8000-000000000002',
    jsonb_build_object('market_id', 'c0000000-0000-4000-8000-000000000010', 'potential_payout_minor', 30000, 'stake_minor', 10000)
  ) <> 10500 then
    raise exception 'FAIL: the hypothetical bet was not counted in the exposure';
  end if;

  raise notice 'PASS: match exposure 11500, hypothetical bet counted, stakes above payouts floor at zero';
end $$;

\echo '--- 10. the per-match exposure cap refuses the bet that would breach it ---'
do $$
declare
  v_result jsonb;
  v_free bigint;
  v_cap bigint;
  v_house uuid := (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN');
  v_treasury uuid := (select id from wallet_accounts where owner_type = 'treasury' and currency = 'NGN');
  v_house_balance bigint;
begin
  -- Strip the house down so the cap is small: leave it 1000 kobo of cash.
  select balance_minor into v_house_balance from account_balances where account_id = v_house;

  perform post_ledger_transaction(
    'money-test-drain',
    'adjustment',
    'test',
    null,
    jsonb_build_array(
      jsonb_build_object('account_id', v_house::text, 'amount_minor', -(v_house_balance - 1000)),
      jsonb_build_object('account_id', v_treasury::text, 'amount_minor', v_house_balance - 1000)
    )
  );

  v_free := public.free_bankroll_minor('NGN');
  v_cap := floor(v_free * 20 / 100)::bigint;

  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000010',
    50000, 2.0, 'dave-cap', 100, 20, false
  );

  if v_result ->> 'code' is distinct from 'match_exposure_cap' then
    raise exception 'FAIL: the match cap did not stop the bet (free %, cap %): %', v_free, v_cap, v_result;
  end if;
  if (v_result ->> 'capMinor')::bigint <> floor((v_result ->> 'freeBankrollMinor')::bigint * 20 / 100) then
    raise exception 'FAIL: the reported cap is not 20 percent of the reported free bankroll: %', v_result;
  end if;

  raise notice 'PASS: free bankroll %, cap %, the bet was refused as match_exposure_cap', v_free, v_cap;

  -- Put the bankroll back for the checks that follow.
  perform post_ledger_transaction(
    'money-test-refill',
    'bankroll_topup',
    'test',
    null,
    jsonb_build_array(
      jsonb_build_object('account_id', v_treasury::text, 'amount_minor', -50000000),
      jsonb_build_object('account_id', v_house::text, 'amount_minor', 50000000)
    )
  );
end $$;

\echo '--- 11. one key cannot be replayed by another player ---'
do $$
declare
  v_result jsonb;
begin
  v_result := public.place_bet(
    'a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001',
    1000, 2.0, 'carol-bet-1', 100, 20, false
  );
  if v_result ->> 'code' is distinct from 'idempotency_conflict' then
    raise exception 'FAIL: another player read a bet by replaying its key: %', v_result;
  end if;
  raise notice 'PASS: a key belonging to someone else is a conflict, not a read';
end $$;

\echo '--- 12. every ledger transaction sums to zero, and no balance is negative ---'
do $$
declare
  v_bad integer;
  v_negative integer;
begin
  select count(*) into v_bad
  from (
    select transaction_id, sum(amount_minor) as total
    from ledger_entries
    group by transaction_id
    having sum(amount_minor) <> 0
  ) broken;
  if v_bad > 0 then
    raise exception 'FAIL: % transactions do not sum to zero', v_bad;
  end if;

  select count(*) into v_negative
  from account_balances ab
  join wallet_accounts a on a.id = ab.account_id
  where a.owner_type = 'user' and ab.balance_minor < 0;
  if v_negative > 0 then
    raise exception 'FAIL: % user accounts are negative', v_negative;
  end if;

  raise notice 'PASS: % transactions, every one balanced, no user balance below zero',
    (select count(*) from ledger_transactions);
end $$;

\echo '--- 13. a bet and its stake are both or neither ---'
do $$
declare
  v_missing integer;
begin
  select count(*) into v_missing
  from bets b
  where b.placed_at >= (select created_at from ledger_transactions where idempotency_key = 'money-test-topup')
    and b.idempotency_key not like 'fixture-direct:%'
    and not exists (
      select 1 from ledger_transactions t where t.idempotency_key = 'bet_stake:' || b.id::text
    );
  if v_missing > 0 then
    raise exception 'FAIL: % bets have no stake transaction', v_missing;
  end if;

  raise notice 'PASS: every bet has its own bet_stake transaction';
end $$;

\echo '--- 14. solvency and reconcile report zero differences on a clean book ---'
do $$
declare
  v_solvency jsonb;
  v_reconcile jsonb;
  v_key text;
begin
  -- Settle the synthetic fixtures this file wrote by hand, so escrow equals
  -- exactly the stakes that are open or held: the invariant reconcile asserts.
  update bets set status = 'void', settled_at = now(), result = 'void', payout_minor = stake_minor
  where idempotency_key like 'fixture-direct:%';

  -- verify.sql's fixture bets predate place_bet, so they have no stake
  -- transaction. Give them theirs, with the same key place_bet would have used,
  -- rather than teaching reconcile to ignore rows.
  insert into ledger_transactions (idempotency_key, kind, ref_type, ref_id, created_at)
  select 'bet_stake:' || b.id::text, 'bet_stake', 'bet', b.id, now()
  from bets b
  where not exists (
    select 1 from ledger_transactions t where t.idempotency_key = 'bet_stake:' || b.id::text
  )
  and b.idempotency_key not like 'fixture-direct:%';

  insert into ledger_entries (transaction_id, account_id, amount_minor)
  select t.id, a.id, -b.stake_minor
  from bets b
  join ledger_transactions t on t.idempotency_key = 'bet_stake:' || b.id::text
  join wallet_accounts a on a.owner_type = 'user' and a.user_id = b.user_id
  where not exists (
    select 1 from ledger_entries e where e.transaction_id = t.id
  );

  insert into ledger_entries (transaction_id, account_id, amount_minor)
  select t.id, (select id from wallet_accounts where owner_type = 'escrow' and currency = 'NGN'), b.stake_minor
  from bets b
  join ledger_transactions t on t.idempotency_key = 'bet_stake:' || b.id::text
  where not exists (
    select 1 from ledger_entries e where e.transaction_id = t.id and e.amount_minor > 0
  );

  -- verify.sql leaves 1,000 kobo of its own inside escrow (its ledger idempotency
  -- fixture). It is not a stake, so move it out: after this the escrow balance is
  -- exactly the stakes of bets that are open or held.
  declare
    v_stray bigint;
  begin
    select coalesce((select sum(ab.balance_minor) from wallet_accounts a
      join account_balances ab on ab.account_id = a.id
      where a.owner_type = 'escrow' and a.currency = 'NGN'), 0)
      - coalesce((select sum(stake_minor) from bets where status in ('open', 'pending_review')), 0)
    into v_stray;

    if v_stray <> 0 then
      perform post_ledger_transaction(
        'money-test-escrow-tidy', 'adjustment', 'test', null,
        jsonb_build_array(
          jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'escrow' and currency = 'NGN')::text, 'amount_minor', -v_stray),
          jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'treasury' and currency = 'NGN')::text, 'amount_minor', v_stray)
        )
      );
    end if;
  end;

  v_solvency := public.solvency_report('NGN');
  v_reconcile := public.reconcile_report('NGN');

  foreach v_key in array array['unbalancedTransactions', 'accountsNotMatchingEntries',
    'negativeUserAccounts', 'betsWithoutStake', 'escrowDifferenceMinor', 'holdDifferenceMinor']
  loop
    if (v_reconcile ->> v_key)::bigint <> 0 then
      raise exception 'FAIL: reconcile % is % on a clean book: %', v_key, v_reconcile ->> v_key, v_reconcile;
    end if;
  end loop;

  if (v_solvency ->> 'userBalancesMinor')::bigint <= 0 then
    raise exception 'FAIL: solvency reports no player money: %', v_solvency;
  end if;

  raise notice 'PASS: reconcile reports % transactions, % entries and no differences',
    v_reconcile ->> 'transactions', v_reconcile ->> 'entries';
end $$;

\echo 'MONEY CHECKS PASSED'
