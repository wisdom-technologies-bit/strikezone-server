-- 005_markets_and_bets.sql
--
-- Betting markets and bets, plus the two views the house uses to stay solvent.
--
-- Money columns are bigint counts of the smallest unit (stake_minor,
-- potential_payout_minor, max_stake_minor). Odds, probabilities and lines are
-- numeric because they are ratios, not money, but they are never multiplied
-- into a money column without rounding to an integer first.

begin;

-- ---------------------------------------------------------------------------
-- markets: one row per selection
-- ---------------------------------------------------------------------------
create table if not exists public.markets (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  market_type text not null,
  subject text not null default '',
  line numeric,
  selection_key text not null,
  status text not null default 'open',
  fair_probability numeric not null,
  odds_decimal numeric not null,
  max_stake_minor bigint,
  is_live boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint markets_status_check
    check (status in ('open', 'suspended', 'closed', 'settled', 'void')),
  constraint markets_fair_probability_check
    check (fair_probability > 0 and fair_probability < 1),
  constraint markets_odds_decimal_check check (odds_decimal >= 1),
  constraint markets_max_stake_minor_check
    check (max_stake_minor is null or max_stake_minor > 0),
  constraint markets_market_type_not_blank_check check (btrim(market_type) <> ''),
  constraint markets_selection_key_not_blank_check check (btrim(selection_key) <> '')
);

comment on table public.markets is
  'One bettable selection. A market is the set of rows sharing match_id, market_type, subject and line; selection_key distinguishes its mutually exclusive selections, each with its own price. So the alternatives of a match winner market are subject = '''' with selection_key ''alice'' and ''bob'', not two different subjects.';
comment on column public.markets.market_type is
  'Kind of market, for example match_winner, total_pockets or handicap.';
comment on column public.markets.subject is
  'What the market is about: a player id, a team, or an empty string for match-level markets.';
comment on column public.markets.line is
  'Handicap or totals line when the market needs one. Null for markets without a line.';
comment on column public.markets.selection_key is
  'The selection inside the market, for example player_id or over/under.';
comment on column public.markets.status is
  'open, suspended, closed, settled or void. Only open markets accept bets.';
comment on column public.markets.fair_probability is
  'Modelled probability before the house margin, between 0 and 1 exclusive.';
comment on column public.markets.odds_decimal is
  'Decimal odds offered to the player, always at least 1. Written by the odds module.';
comment on column public.markets.max_stake_minor is
  'Stake cap for this selection in the smallest currency unit. Null means the global cap applies.';
comment on column public.markets.is_live is
  'True when the market is offered while the match is in play.';
comment on column public.markets.updated_at is
  'Maintained by trigger on every update, so the site can price movements and detect stale quotes.';

-- A selection is identified by its market coordinates. NULLS NOT DISTINCT keeps
-- line-less markets from being inserted twice (requires Postgres 15 or newer).
create unique index if not exists markets_selection_key
  on public.markets (match_id, market_type, subject, line, selection_key)
  nulls not distinct;

create index if not exists markets_match_id_status_idx
  on public.markets (match_id, status);

create or replace function public.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.touch_updated_at() is
  'Sets updated_at on the row being updated. Attached to tables that carry their own updated_at column.';

drop trigger if exists markets_touch_updated_at on public.markets;
create trigger markets_touch_updated_at
  before update on public.markets
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- bets
-- ---------------------------------------------------------------------------
create table if not exists public.bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  market_id uuid not null references public.markets (id) on delete restrict,
  stake_minor bigint not null,
  odds_locked numeric not null,
  potential_payout_minor bigint not null,
  status text not null default 'open',
  idempotency_key text not null,
  placed_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint bets_stake_minor_check check (stake_minor > 0),
  constraint bets_odds_locked_check check (odds_locked >= 1),
  constraint bets_potential_payout_minor_check check (potential_payout_minor > 0),
  constraint bets_status_check
    check (status in ('open', 'won', 'lost', 'void', 'cashed_out')),
  constraint bets_idempotency_key_key unique (idempotency_key),
  constraint bets_idempotency_key_not_blank_check check (btrim(idempotency_key) <> ''),
  constraint bets_settled_at_check check ((status = 'open') = (settled_at is null))
);

comment on table public.bets is
  'A player stake on one selection at a locked price. Placing a bet debits the stake through the ledger; settling it credits the payout or refunds it.';
comment on column public.bets.stake_minor is
  'Stake in the smallest currency unit. Always greater than zero.';
comment on column public.bets.odds_locked is
  'Decimal odds at placement. Never re-priced afterwards, so a later odds change cannot alter an existing bet.';
comment on column public.bets.potential_payout_minor is
  'Payout if the bet wins, in the smallest currency unit: round(stake_minor * odds_locked) computed once at placement, never recomputed.';
comment on column public.bets.status is
  'open, won, lost, void or cashed_out.';
comment on column public.bets.idempotency_key is
  'Caller-supplied unique key, so a retried placement cannot create a second bet.';
comment on column public.bets.settled_at is
  'Set exactly when the bet leaves open status.';

create index if not exists bets_user_id_idx on public.bets (user_id);
create index if not exists bets_market_id_idx on public.bets (market_id);
create index if not exists bets_status_idx on public.bets (status);
create index if not exists bets_open_market_idx on public.bets (market_id) where status = 'open';

-- ---------------------------------------------------------------------------
-- open_liability: the worst case the house owes on each match
-- ---------------------------------------------------------------------------
create or replace view public.open_liability
with (security_invoker = true) as
with open_payouts as (
  -- Payout owed per selection if that selection wins.
  select
    m.match_id,
    m.market_type,
    m.subject,
    m.line,
    m.selection_key,
    sum(b.potential_payout_minor)::bigint as payout_minor
  from public.bets b
  join public.markets m on m.id = b.market_id
  where b.status = 'open'
  group by m.match_id, m.market_type, m.subject, m.line, m.selection_key
),
worst_selection_per_market as (
  -- Only one selection of a market can win, so take the dearest one.
  select
    match_id,
    market_type,
    subject,
    line,
    max(payout_minor)::bigint as worst_minor
  from open_payouts
  group by match_id, market_type, subject, line
)
select
  mt.id as match_id,
  coalesce(sum(w.worst_minor), 0)::bigint as liability_minor
from public.matches mt
left join worst_selection_per_market w on w.match_id = mt.id
group by mt.id;

comment on view public.open_liability is
  'Worst-case payout the house owes per match, from open bets only. A market is taken to be the rows sharing match_id, market_type, subject and line, so only one of its selections can win and the dearest one is assumed to win; the per-market worst cases are then summed. That sum is a deliberate upper bound, because selections in different markets of the same match are correlated by the game outcome, which this schema does not model. Because subject is part of the market identity, modelling a match winner market with one subject per player would overstate liability: alternatives belong in selection_key.';

-- ---------------------------------------------------------------------------
-- house_bankroll: house money against outstanding liability
-- ---------------------------------------------------------------------------
create or replace view public.house_bankroll
with (security_invoker = true) as
with house_accounts as (
  select a.id, a.currency
  from public.wallet_accounts a
  where a.owner_type = 'house'
),
house_balances as (
  select
    h.currency,
    coalesce(sum(b.balance_minor), 0)::bigint as balance_minor
  from house_accounts h
  left join public.account_balances b on b.account_id = h.id
  group by h.currency
),
liability as (
  select coalesce(sum(ol.liability_minor), 0)::bigint as open_liability_minor
  from public.open_liability ol
)
select
  hb.currency,
  hb.balance_minor,
  l.open_liability_minor,
  (hb.balance_minor - l.open_liability_minor)::bigint as free_minor
from house_balances hb
cross join liability l;

comment on view public.house_bankroll is
  'House balance, outstanding worst-case liability and the free balance left (balance minus liability) per house currency. One row per house account currency: amounts in different currencies are never added together. Open liability carries no currency of its own because bets do not store one, so it is treated as being in the platform currency.';

commit;
