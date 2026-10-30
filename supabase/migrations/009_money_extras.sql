-- 009_money_extras.sql
--
-- The money layer above the ledger: placing a bet atomically, deposits and
-- withdrawals, responsible-play limits, solvency snapshots, the admin audit
-- trail and the kill switches.
--
-- Three ideas hold this file together:
--
-- 1. No behaviour lives only in TypeScript. The bet placement that must be
--    atomic (market status, odds, limits, funds, exposure, the bet row and the
--    stake movement) is one PL/pgSQL function, so a crash or a second request
--    can never land a bet without its stake, or a stake without its bet.
-- 2. Exposure is an upper bound by construction. A market's exposure is the
--    dearest selection's total payout minus the stakes collected on that market,
--    floored at zero; a match's exposure is the sum over its markets. Different
--    markets of one match are correlated by the same game result, so summing is
--    a deliberate over-estimate: the cap errs towards refusing a bet.
-- 3. Money that is owed but not yet released sits in an account, never in a
--    boolean. Held payouts stay in escrow until an admin approves; withdrawal
--    requests sit in withdrawal_hold until the transfer is paid or returned.
--
-- Safe to re-run: every table is created conditionally and every constraint is
-- named and dropped before being added.

begin;

-- ---------------------------------------------------------------------------
-- wallet_accounts: two more kinds of pot
-- ---------------------------------------------------------------------------
alter table public.wallet_accounts
  drop constraint if exists wallet_accounts_owner_type_check;

alter table public.wallet_accounts
  add constraint wallet_accounts_owner_type_check
  check (owner_type in ('user', 'house', 'escrow', 'prize_pool', 'treasury', 'withdrawal_hold'));

comment on column public.wallet_accounts.owner_type is
  'user, house, escrow, prize_pool, treasury or withdrawal_hold. Treasury is where money the operator puts in comes from; withdrawal_hold holds money owed to users while a withdrawal is being paid.';

-- Exactly one treasury account and one withdrawal_hold account per currency.
create unique index if not exists wallet_accounts_one_treasury_per_currency_key
  on public.wallet_accounts (currency)
  where owner_type = 'treasury';

create unique index if not exists wallet_accounts_one_withdrawal_hold_per_currency_key
  on public.wallet_accounts (currency)
  where owner_type = 'withdrawal_hold';

-- ---------------------------------------------------------------------------
-- bets: a held payout is a status, not a flag
-- ---------------------------------------------------------------------------
alter table public.bets drop constraint if exists bets_status_check;

alter table public.bets
  add constraint bets_status_check
  check (status in ('open', 'pending_review', 'won', 'lost', 'void', 'cashed_out'));

comment on column public.bets.status is
  'open while at risk; pending_review when the bet has won but the payout is above the large-payout threshold and waits for an admin; won, lost or void once settled; cashed_out for a future early settlement.';

alter table public.bets add column if not exists result text;
alter table public.bets drop constraint if exists bets_result_check;
alter table public.bets
  add constraint bets_result_check
  check (result is null or result in ('won', 'lost', 'void', 'push'));

alter table public.bets add column if not exists payout_minor bigint;
alter table public.bets drop constraint if exists bets_payout_minor_check;
alter table public.bets
  add constraint bets_payout_minor_check
  check (payout_minor is null or payout_minor >= 0);

alter table public.bets add column if not exists review_reason text;

alter table public.bets add column if not exists reviewed_at timestamptz;
alter table public.bets add column if not exists reviewed_by text;

comment on column public.bets.result is
  'What the market decided: won, lost, void or push. Null while the bet is open, and set at settlement even when the payout is held for review.';
comment on column public.bets.payout_minor is
  'What the player is owed for this bet in the smallest unit: the locked potential payout when it won, the stake when it was void or pushed, zero when it lost.';
comment on column public.bets.review_reason is
  'Why a winning payout is held for review, for example large_payout.';

create index if not exists bets_pending_review_idx
  on public.bets (placed_at)
  where status = 'pending_review';

-- ---------------------------------------------------------------------------
-- matches: flagged when settlement could not trust the result
-- ---------------------------------------------------------------------------
alter table public.matches add column if not exists flagged_at timestamptz;
alter table public.matches add column if not exists flagged_reason text;

comment on column public.matches.flagged_at is
  'When settlement refused to trust this match. A flagged match settles nothing until a human looks at it.';

-- ---------------------------------------------------------------------------
-- profiles: which kind of exclusion is running
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists self_exclusion_kind text;
alter table public.profiles drop constraint if exists profiles_self_exclusion_kind_check;
alter table public.profiles
  add constraint profiles_self_exclusion_kind_check
  check (self_exclusion_kind is null or self_exclusion_kind in ('self_exclusion', 'cool_off'));

comment on column public.profiles.self_exclusion_kind is
  'self_exclusion is the full block; cool_off is the same block for a short period the player chose. Both are enforced by place_bet and by the deposit path.';

-- ---------------------------------------------------------------------------
-- user_limits: responsible-play limits, with the 24 hour rule
-- ---------------------------------------------------------------------------
create table if not exists public.user_limits (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  daily_deposit_limit_minor bigint,
  daily_loss_limit_minor bigint,
  max_stake_minor bigint,
  pending_daily_deposit_limit_minor bigint,
  pending_daily_loss_limit_minor bigint,
  pending_max_stake_minor bigint,
  pending_effective_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint user_limits_non_negative_check check (
    coalesce(daily_deposit_limit_minor, 0) >= 0
    and coalesce(daily_loss_limit_minor, 0) >= 0
    and coalesce(max_stake_minor, 0) >= 0
    and coalesce(pending_daily_deposit_limit_minor, 0) >= 0
    and coalesce(pending_daily_loss_limit_minor, 0) >= 0
    and coalesce(pending_max_stake_minor, 0) >= 0
  ),
  constraint user_limits_pending_shape_check check (
    (
      pending_effective_at is null
      and pending_daily_deposit_limit_minor is null
      and pending_daily_loss_limit_minor is null
      and pending_max_stake_minor is null
    )
    or pending_effective_at is not null
  )
);

comment on table public.user_limits is
  'Per-player responsible-play limits. Null means no limit. A relaxation waits in the pending columns until pending_effective_at (24 hours), so a limit can be lowered at once but never raised at once.';
comment on column public.user_limits.pending_effective_at is
  'When the pending limits take over. Set 24 hours after a player asks for a looser limit; null when nothing is pending.';

drop trigger if exists user_limits_touch_updated_at on public.user_limits;
create trigger user_limits_touch_updated_at
  before update on public.user_limits
  for each row execute function public.touch_updated_at();

-- The limits actually in force right now: pending values only once they are due.
create or replace function public.effective_limits(p_user_id uuid)
returns table (
  daily_deposit_limit_minor bigint,
  daily_loss_limit_minor bigint,
  max_stake_minor bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    case
      when l.pending_effective_at is not null and l.pending_effective_at <= now()
        then l.pending_daily_deposit_limit_minor
      else l.daily_deposit_limit_minor
    end as daily_deposit_limit_minor,
    case
      when l.pending_effective_at is not null and l.pending_effective_at <= now()
        then l.pending_daily_loss_limit_minor
      else l.daily_loss_limit_minor
    end as daily_loss_limit_minor,
    case
      when l.pending_effective_at is not null and l.pending_effective_at <= now()
        then l.pending_max_stake_minor
      else l.max_stake_minor
    end as max_stake_minor
  from (select p_user_id as user_id) u
  left join public.user_limits l on l.user_id = u.user_id;
$$;

comment on function public.effective_limits(uuid) is
  'The limits in force for a player right now: pending values apply only once pending_effective_at has passed. Always returns one row.';

-- Stakes already lost today, which the daily loss limit is measured against.
create or replace function public.daily_loss_minor(p_user_id uuid, p_at timestamptz default now())
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(b.stake_minor), 0)::bigint
  from public.bets b
  where b.user_id = p_user_id
    and b.status = 'lost'
    and b.settled_at >= date_trunc('day', p_at);
$$;

comment on function public.daily_loss_minor(uuid, timestamptz) is
  'Total stakes the player has lost so far today (server day), for the daily loss limit.';

-- ---------------------------------------------------------------------------
-- deposits
-- ---------------------------------------------------------------------------
create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  provider text not null,
  provider_ref text not null,
  amount_minor bigint not null,
  currency text not null default 'NGN',
  status text not null default 'pending',
  note text,
  created_at timestamptz not null default now(),
  credited_at timestamptz,
  constraint deposits_amount_minor_check check (amount_minor > 0),
  constraint deposits_currency_format_check check (currency ~ '^[A-Z]{3}$'),
  constraint deposits_status_check
    check (status in ('pending', 'credited', 'failed', 'cancelled')),
  constraint deposits_credited_at_check check ((status = 'credited') = (credited_at is not null)),
  constraint deposits_provider_ref_key unique (provider, provider_ref)
);

comment on table public.deposits is
  'Money coming in. A deposit is credited exactly once: the provider reference is unique per provider, and the credit goes through the ledger with a key derived from this row id.';
comment on column public.deposits.provider_ref is
  'The provider''s own reference for this payment. Unique per provider, so a replayed webhook can never credit twice.';

create index if not exists deposits_user_created_idx on public.deposits (user_id, created_at desc);
create index if not exists deposits_pending_idx on public.deposits (created_at) where status = 'pending';

-- Deposits credited today, which the daily deposit limit is measured against.
create or replace function public.daily_deposited_minor(p_user_id uuid, p_at timestamptz default now())
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(d.amount_minor), 0)::bigint
  from public.deposits d
  where d.user_id = p_user_id
    and d.status = 'credited'
    and d.credited_at >= date_trunc('day', p_at);
$$;

comment on function public.daily_deposited_minor(uuid, timestamptz) is
  'Total credited deposits for the player so far today (server day), for the daily deposit limit.';

-- ---------------------------------------------------------------------------
-- withdrawals
-- ---------------------------------------------------------------------------
create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  amount_minor bigint not null,
  currency text not null default 'NGN',
  provider text not null,
  provider_ref text,
  status text not null default 'requested',
  destination text,
  reason text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  paid_at timestamptz,
  decided_by text,
  constraint withdrawals_amount_minor_check check (amount_minor > 0),
  constraint withdrawals_currency_format_check check (currency ~ '^[A-Z]{3}$'),
  constraint withdrawals_status_check
    check (status in ('requested', 'approved', 'paid', 'rejected')),
  constraint withdrawals_paid_at_check check ((status = 'paid') = (paid_at is not null)),
  constraint withdrawals_decided_at_check
    check ((status = 'requested') = (decided_at is null)),
  constraint withdrawals_provider_ref_key unique (provider, provider_ref)
);

comment on table public.withdrawals is
  'Money going out. The amount leaves the player and sits in withdrawal_hold the moment the request is made; approving does not move money, marking paid finishes it, rejecting returns it.';

create index if not exists withdrawals_user_requested_idx
  on public.withdrawals (user_id, requested_at desc);
create index if not exists withdrawals_open_idx
  on public.withdrawals (requested_at)
  where status in ('requested', 'approved');

-- ---------------------------------------------------------------------------
-- solvency_snapshots: what the operator says the cash really is
-- ---------------------------------------------------------------------------
create table if not exists public.solvency_snapshots (
  id uuid primary key default gen_random_uuid(),
  cash_reported_minor bigint not null,
  user_liabilities_minor bigint not null,
  house_funds_minor bigint not null,
  note text,
  created_at timestamptz not null default now(),
  constraint solvency_snapshots_cash_reported_check check (cash_reported_minor >= 0),
  constraint solvency_snapshots_user_liabilities_check check (user_liabilities_minor >= 0)
);

comment on table public.solvency_snapshots is
  'A dated statement of the cash the operator actually holds, next to what the ledger says players are owed. The gap is the number that matters: negative means players could ask for money that is not there.';

-- ---------------------------------------------------------------------------
-- admin_actions: every operator action, in order
-- ---------------------------------------------------------------------------
create table if not exists public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  target_type text,
  target_id text,
  payload jsonb not null default '{}'::jsonb,
  actor text not null default 'admin',
  created_at timestamptz not null default now(),
  constraint admin_actions_action_not_blank_check check (btrim(action) <> '')
);

comment on table public.admin_actions is
  'Append-only audit of operator actions: top-ups, approvals, rejections, suspensions and snapshots. Written by the server for every admin call that changes something.';

create index if not exists admin_actions_created_idx on public.admin_actions (created_at desc);
create index if not exists admin_actions_target_idx on public.admin_actions (target_type, target_id);

-- ---------------------------------------------------------------------------
-- system_flags: the kill switches
-- ---------------------------------------------------------------------------
create table if not exists public.system_flags (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint system_flags_key_not_blank_check check (btrim(key) <> '')
);

comment on table public.system_flags is
  'Operational switches that must survive a restart. betting = {"paused": true} stops every new bet; the per-market switch is markets.status = suspended.';

insert into public.system_flags (key, value)
values ('betting', '{"paused": false}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- payment_webhook_events: webhooks are processed once
-- ---------------------------------------------------------------------------
create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  constraint payment_webhook_events_event_key unique (provider, event_id)
);

comment on table public.payment_webhook_events is
  'Every webhook as it arrived, keyed by the provider event id, so a redelivery is recognised instead of credited again.';

-- ---------------------------------------------------------------------------
-- exposure: the upper bound the caps are measured against
-- ---------------------------------------------------------------------------
create or replace function public.exposure_minor(
  p_match_id uuid default null,
  p_extra jsonb default null
) returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidate_bets as (
    -- Every open bet, plus the hypothetical one being considered.
    select
      m.match_id,
      m.market_type,
      m.subject,
      m.line,
      m.selection_key,
      b.potential_payout_minor::bigint as payout_minor,
      b.stake_minor::bigint as stake_minor
    from public.bets b
    join public.markets m on m.id = b.market_id
    where b.status = 'open'
      and (p_match_id is null or m.match_id = p_match_id)

    union all

    select
      m.match_id,
      m.market_type,
      m.subject,
      m.line,
      m.selection_key,
      (p_extra ->> 'potential_payout_minor')::bigint,
      (p_extra ->> 'stake_minor')::bigint
    from public.markets m
    where p_extra is not null
      and m.id = (p_extra ->> 'market_id')::uuid
      and (p_match_id is null or m.match_id = p_match_id)
  ),
  per_selection as (
    select
      match_id,
      market_type,
      subject,
      line,
      selection_key,
      sum(payout_minor)::bigint as payout_minor,
      sum(stake_minor)::bigint as stake_minor
    from candidate_bets
    group by match_id, market_type, subject, line, selection_key
  ),
  per_market as (
    -- One selection of a market can win, so only the dearest one is at risk.
    select
      match_id,
      market_type,
      subject,
      line,
      max(payout_minor)::bigint as worst_payout_minor,
      sum(stake_minor)::bigint as market_stake_minor
    from per_selection
    group by match_id, market_type, subject, line
  )
  select coalesce(sum(greatest(0, worst_payout_minor - market_stake_minor)), 0)::bigint
  from per_market;
$$;

comment on function public.exposure_minor(uuid, jsonb) is
  'Worst case the house can owe. Per market: the dearest selection''s payouts minus the stakes taken on that market, floored at zero. Match exposure sums its markets; passing a null match sums every match, which is global exposure. p_extra adds a hypothetical bet {market_id, potential_payout_minor, stake_minor} so a placement can be judged before it is written.';

-- The same number, but worked out from the hypothetical bet's own market.
create or replace function public.match_exposure_minor(p_match_id uuid, p_extra jsonb default null)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.exposure_minor(p_match_id, p_extra);
$$;

comment on function public.match_exposure_minor(uuid, jsonb) is
  'Exposure of one match, optionally counting a hypothetical bet. Named separately because placement compares this number to a per-match cap while the global cap uses exposure_minor(null, ...).';

-- Cash the house can afford to lose: the house balance less what is already at risk.
create or replace function public.free_bankroll_minor(p_currency text)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select ab.balance_minor
      from public.wallet_accounts a
      join public.account_balances ab on ab.account_id = a.id
      where a.owner_type = 'house'
        and a.currency = p_currency
      limit 1
    ),
    0
  )::bigint - public.exposure_minor(null, null);
$$;

comment on function public.free_bankroll_minor(text) is
  'House balance minus all open exposure, in one currency. Negative means the house is already promising more than it holds.';

-- ---------------------------------------------------------------------------
-- place_bet: one transaction, or nothing
-- ---------------------------------------------------------------------------
create or replace function public.place_bet(
  p_user_id uuid,
  p_market_id uuid,
  p_stake_minor bigint,
  p_expected_odds numeric,
  p_idempotency_key text,
  p_min_stake_minor bigint default 100,
  p_match_exposure_pct numeric default 20,
  p_require_kyc boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.bets;
  v_market public.markets;
  v_profile public.profiles;
  v_limits record;
  v_betting_paused boolean;
  v_currency text;
  v_user_account uuid;
  v_escrow_account uuid;
  v_house_account uuid;
  v_house_balance bigint;
  v_balance bigint;
  v_payout bigint;
  v_bet public.bets;
  v_rate_count integer;
  v_daily_loss bigint;
  v_match_id uuid;
  v_extra jsonb;
  v_match_exposure bigint;
  v_global_exposure bigint;
  v_current_exposure bigint;
  v_free bigint;
  v_cap bigint;
begin
  -- 1. Shape first: nothing below has to defend against a null or a negative.
  if p_user_id is null or p_market_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if p_stake_minor is null or p_stake_minor <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_stake');
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    return jsonb_build_object('ok', false, 'code', 'invalid_idempotency_key');
  end if;
  if p_expected_odds is null or p_expected_odds < 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_odds');
  end if;

  -- 2. A replayed key returns the original bet, and only to the same player.
  select * into v_existing from public.bets where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.market_id <> p_market_id then
      return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
    end if;
    return jsonb_build_object(
      'ok', true,
      'replayed', true,
      'bet', to_jsonb(v_existing),
      'balanceMinor', 0
    );
  end if;

  -- 3. The global kill switch, then the per-market lock. Lock order is profiles,
  --    then markets, then the house account, then the user account, in that
  --    order in every path that takes more than one, so nobody deadlocks.
  select coalesce((value ->> 'paused')::boolean, false)
    into v_betting_paused
  from public.system_flags
  where key = 'betting';

  if coalesce(v_betting_paused, false) then
    return jsonb_build_object('ok', false, 'code', 'betting_paused');
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'user_not_found');
  end if;

  if v_profile.self_excluded_until is not null and v_profile.self_excluded_until > now() then
    return jsonb_build_object(
      'ok', false,
      'code', 'self_excluded',
      'until', v_profile.self_excluded_until
    );
  end if;

  if p_require_kyc and v_profile.kyc_status <> 'verified' then
    return jsonb_build_object('ok', false, 'code', 'kyc_required', 'kycStatus', v_profile.kyc_status);
  end if;

  select * into v_market from public.markets where id = p_market_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;

  if v_market.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'market_closed', 'marketStatus', v_market.status);
  end if;

  if v_market.odds_decimal < p_expected_odds then
    return jsonb_build_object(
      'ok', false,
      'code', 'odds_moved',
      'currentOdds', v_market.odds_decimal,
      'expectedOdds', p_expected_odds
    );
  end if;

  -- 4. Stake size: the floor comes from configuration, the ceiling from the market.
  if p_stake_minor < p_min_stake_minor then
    return jsonb_build_object(
      'ok', false,
      'code', 'stake_below_minimum',
      'minStakeMinor', p_min_stake_minor
    );
  end if;

  if p_stake_minor > v_market.max_stake_minor then
    return jsonb_build_object(
      'ok', false,
      'code', 'stake_above_market_max',
      'maxStakeMinor', v_market.max_stake_minor
    );
  end if;

  -- 5. Responsible-play limits, as they stand right now.
  select * into v_limits from public.effective_limits(p_user_id);

  if v_limits.max_stake_minor is not null and p_stake_minor > v_limits.max_stake_minor then
    return jsonb_build_object(
      'ok', false,
      'code', 'stake_above_limit',
      'maxStakeMinor', v_limits.max_stake_minor
    );
  end if;

  if v_limits.daily_loss_limit_minor is not null then
    v_daily_loss := public.daily_loss_minor(p_user_id) + p_stake_minor;
    if v_daily_loss > v_limits.daily_loss_limit_minor then
      return jsonb_build_object(
        'ok', false,
        'code', 'daily_loss_limit',
        'dailyLossLimitMinor', v_limits.daily_loss_limit_minor,
        'wouldReachMinor', v_daily_loss
      );
    end if;
  end if;

  -- 6. Rate limit: ten bets a minute, counted from the bet rows themselves.
  select count(*)::integer into v_rate_count
  from public.bets
  where user_id = p_user_id
    and placed_at > now() - interval '1 minute';

  if v_rate_count >= 10 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'perMinute', 10);
  end if;

  -- 7. Accounts. The house lock serialises exposure checks across matches.
  select currency into v_currency
  from public.wallet_accounts
  where owner_type = 'user' and user_id = p_user_id
  limit 1;

  v_currency := coalesce(v_currency, 'NGN');

  select id into v_house_account
  from public.wallet_accounts
  where owner_type = 'house' and currency = v_currency
  for update;

  if v_house_account is null then
    return jsonb_build_object('ok', false, 'code', 'house_account_missing');
  end if;

  select id into v_escrow_account
  from public.wallet_accounts
  where owner_type = 'escrow' and currency = v_currency;

  if v_escrow_account is null then
    return jsonb_build_object('ok', false, 'code', 'escrow_account_missing');
  end if;

  select id into v_user_account
  from public.wallet_accounts
  where owner_type = 'user' and user_id = p_user_id and currency = v_currency
  for update;

  if v_user_account is null then
    -- No wallet yet means no money: create it so the next deposit lands in one.
    insert into public.wallet_accounts (owner_type, user_id, currency)
    values ('user', p_user_id, v_currency)
    returning id into v_user_account;
  end if;

  select coalesce(balance_minor, 0) into v_balance
  from public.account_balances
  where account_id = v_user_account;

  if coalesce(v_balance, 0) < p_stake_minor then
    return jsonb_build_object(
      'ok', false,
      'code', 'insufficient_funds',
      'balanceMinor', coalesce(v_balance, 0)
    );
  end if;

  -- 8. Exposure, with this bet counted and the house lock held.
  v_payout := floor(p_stake_minor * v_market.odds_decimal)::bigint;
  v_match_id := v_market.match_id;
  v_extra := jsonb_build_object(
    'market_id', p_market_id,
    'potential_payout_minor', v_payout,
    'stake_minor', p_stake_minor
  );

  select coalesce(balance_minor, 0) into v_house_balance
  from public.account_balances
  where account_id = v_house_account;

  v_current_exposure := public.exposure_minor(null, null);
  v_free := coalesce(v_house_balance, 0) - v_current_exposure;
  v_match_exposure := public.exposure_minor(v_match_id, v_extra);
  v_global_exposure := public.exposure_minor(null, v_extra);

  -- A match may take at most a fifth of what the house can afford to lose.
  v_cap := floor(v_free * p_match_exposure_pct / 100)::bigint;

  if v_match_exposure > v_cap then
    return jsonb_build_object(
      'ok', false,
      'code', 'match_exposure_cap',
      'matchExposureMinor', v_match_exposure,
      'capMinor', v_cap,
      'freeBankrollMinor', v_free,
      'matchExposurePct', p_match_exposure_pct
    );
  end if;

  if v_global_exposure > v_free then
    return jsonb_build_object(
      'ok', false,
      'code', 'global_exposure_cap',
      'globalExposureMinor', v_global_exposure,
      'freeBankrollMinor', v_free
    );
  end if;

  -- 9. Write the bet, then move the stake. Both or neither: one transaction.
  insert into public.bets (
    user_id,
    market_id,
    stake_minor,
    odds_locked,
    potential_payout_minor,
    status,
    idempotency_key
  ) values (
    p_user_id,
    p_market_id,
    p_stake_minor,
    v_market.odds_decimal,
    v_payout,
    'open',
    p_idempotency_key
  )
  returning * into v_bet;

  perform public.post_ledger_transaction(
    'bet_stake:' || v_bet.id::text,
    'bet_stake',
    'bet',
    v_bet.id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_user_account::text, 'amount_minor', -p_stake_minor),
      jsonb_build_object('account_id', v_escrow_account::text, 'amount_minor', p_stake_minor)
    )
  );

  select coalesce(balance_minor, 0) into v_balance
  from public.account_balances
  where account_id = v_user_account;

  return jsonb_build_object(
    'ok', true,
    'replayed', false,
    'bet', to_jsonb(v_bet),
    'balanceMinor', coalesce(v_balance, 0),
    'oddsLocked', v_bet.odds_locked,
    'potentialPayoutMinor', v_bet.potential_payout_minor
  );
end;
$$;

comment on function public.place_bet(uuid, uuid, bigint, numeric, text, bigint, numeric, boolean) is
  'Places one bet, or refuses with a code. Everything happens inside this transaction with the profile, market, house account and wallet row locked: market state, odds drift, stake floor and ceiling, responsible-play limits, rate limit, funds and the exposure caps. The stake moves user to escrow through post_ledger_transaction under key bet_stake:<bet id>, so a replay is a no-op.';

-- ---------------------------------------------------------------------------
-- Row level security for the new tables
-- ---------------------------------------------------------------------------
alter table public.user_limits enable row level security;
alter table public.deposits enable row level security;
alter table public.withdrawals enable row level security;
alter table public.solvency_snapshots enable row level security;
alter table public.admin_actions enable row level security;
alter table public.system_flags enable row level security;
alter table public.payment_webhook_events enable row level security;

drop policy if exists user_limits_select_own on public.user_limits;
create policy user_limits_select_own on public.user_limits
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists deposits_select_own on public.deposits;
create policy deposits_select_own on public.deposits
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists withdrawals_select_own on public.withdrawals;
create policy withdrawals_select_own on public.withdrawals
  for select to authenticated
  using (user_id = (select auth.uid()));

-- No policy at all on solvency_snapshots, admin_actions, system_flags or
-- payment_webhook_events: server-side only, for every browser role.

revoke insert, update, delete, truncate on
  public.user_limits,
  public.deposits,
  public.withdrawals,
  public.solvency_snapshots,
  public.admin_actions,
  public.system_flags,
  public.payment_webhook_events
from anon, authenticated;

grant select on public.user_limits, public.deposits, public.withdrawals to authenticated;
grant all on public.user_limits, public.deposits, public.withdrawals,
  public.solvency_snapshots, public.admin_actions, public.system_flags,
  public.payment_webhook_events
to service_role;

-- The two account kinds the money paths need, so a fresh database can place a
-- bet before any deposit has happened.
insert into public.wallet_accounts (owner_type, currency)
select 'treasury', c.currency
from (select distinct currency from public.wallet_accounts) c
on conflict do nothing;

insert into public.wallet_accounts (owner_type, currency)
select 'withdrawal_hold', c.currency
from (select distinct currency from public.wallet_accounts) c
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- solvency_report: what the ledger says the business holds and owes
-- ---------------------------------------------------------------------------
create or replace function public.solvency_report(p_currency text default 'NGN')
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with accounts as (
    select a.owner_type, coalesce(sum(ab.balance_minor), 0)::bigint as balance_minor
    from public.wallet_accounts a
    left join public.account_balances ab on ab.account_id = a.id
    where a.currency = p_currency
    group by a.owner_type
  )
  select jsonb_build_object(
    'currency', p_currency,
    'userBalancesMinor', coalesce((select balance_minor from accounts where owner_type = 'user'), 0),
    'escrowMinor', coalesce((select balance_minor from accounts where owner_type = 'escrow'), 0),
    'withdrawalHoldMinor',
      coalesce((select balance_minor from accounts where owner_type = 'withdrawal_hold'), 0),
    'houseMinor', coalesce((select balance_minor from accounts where owner_type = 'house'), 0),
    'treasuryMinor', coalesce((select balance_minor from accounts where owner_type = 'treasury'), 0),
    'prizePoolMinor',
      coalesce((select balance_minor from accounts where owner_type = 'prize_pool'), 0),
    'openExposureMinor', public.exposure_minor(null, null),
    'freeBankrollMinor', public.free_bankroll_minor(p_currency),
    'heldPayoutsMinor',
      coalesce((select sum(payout_minor) from public.bets where status = 'pending_review'), 0),
    'openBetsMinor', coalesce((select sum(stake_minor) from public.bets where status = 'open'), 0),
    'openWithdrawalsMinor',
      coalesce((select sum(amount_minor) from public.withdrawals where status in ('requested', 'approved')), 0)
  );
$$;

comment on function public.solvency_report(text) is
  'One currency''s position in one object: what players hold, what is escrowed, what is owed out, what the house and treasury hold, the open exposure and the free bankroll. The admin solvency endpoint returns this, plus the gap against the last cash snapshot.';

-- ---------------------------------------------------------------------------
-- reconcile_report: the differences an operator must be able to prove are zero
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_report(p_currency text default 'NGN')
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with unbalanced as (
    select count(*)::integer as n
    from (
      select transaction_id
      from public.ledger_entries
      group by transaction_id
      having sum(amount_minor) <> 0
    ) broken
  ),
  mismatched as (
    select count(*)::integer as n
    from public.wallet_accounts a
    left join public.account_balances ab on ab.account_id = a.id
    left join (
      select account_id, sum(amount_minor)::bigint as total
      from public.ledger_entries
      group by account_id
    ) e on e.account_id = a.id
    where coalesce(ab.balance_minor, 0) <> coalesce(e.total, 0)
  ),
  negative_users as (
    select count(*)::integer as n
    from public.account_balances ab
    join public.wallet_accounts a on a.id = ab.account_id
    where a.owner_type = 'user' and ab.balance_minor < 0
  ),
  unstaked_bets as (
    -- Every bet placed through place_bet must have its stake transaction.
    select count(*)::integer as n
    from public.bets b
    where not exists (
      select 1 from public.ledger_transactions t where t.idempotency_key = 'bet_stake:' || b.id::text
    )
    and b.idempotency_key not like 'fixture-direct:%'
  ),
  escrow_check as (
    select
      coalesce((select sum(ab.balance_minor) from public.wallet_accounts a
        join public.account_balances ab on ab.account_id = a.id
        where a.owner_type = 'escrow' and a.currency = p_currency), 0)::bigint as actual,
      (
        coalesce((select sum(stake_minor) from public.bets where status = 'open'), 0)
        + coalesce((select sum(stake_minor) from public.bets where status = 'pending_review'), 0)
      )::bigint as expected
  ),
  hold_check as (
    select
      coalesce((select sum(ab.balance_minor) from public.wallet_accounts a
        join public.account_balances ab on ab.account_id = a.id
        where a.owner_type = 'withdrawal_hold' and a.currency = p_currency), 0)::bigint as actual,
      coalesce((select sum(amount_minor) from public.withdrawals where status in ('requested', 'approved')), 0)::bigint as expected
  )
  select jsonb_build_object(
    'currency', p_currency,
    'unbalancedTransactions', (select n from unbalanced),
    'accountsNotMatchingEntries', (select n from mismatched),
    'negativeUserAccounts', (select n from negative_users),
    'betsWithoutStake', (select n from unstaked_bets),
    'escrowActualMinor', (select actual from escrow_check),
    'escrowExpectedMinor', (select expected from escrow_check),
    'escrowDifferenceMinor', (select actual - expected from escrow_check),
    'holdActualMinor', (select actual from hold_check),
    'holdExpectedMinor', (select expected from hold_check),
    'holdDifferenceMinor', (select actual - expected from hold_check),
    'transactions', (select count(*) from public.ledger_transactions),
    'entries', (select count(*) from public.ledger_entries)
  );
$$;

comment on function public.reconcile_report(text) is
  'The accounting invariants as counts and differences: unbalanced transactions, accounts whose balance is not the sum of their entries, negative user wallets, bets without a stake transaction, and escrow and withdrawal_hold against what they are supposed to hold. Every field must be zero for a clean book.';


commit;
