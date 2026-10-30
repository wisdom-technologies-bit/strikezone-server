-- 011_admin_audit_alerts.sql
--
-- The tables the operator surface and the alerting need, on top of 009's
-- admin_actions (which is this schema's audit log: append-only, one row per
-- operator action, written by the server before it reports success).
--
-- New here:
--
--   alerts              every condition somebody should be woken for: free
--                       bankroll below its floor, a settlement that failed, a
--                       verification that failed. Written even when no webhook
--                       is configured, because a row outlives a lost POST.
--   market_overrides    per-market stake ceiling and margin that survive a
--                       restart and apply to the next pricing run, so an
--                       operator can tighten one market without a deploy.
--   bot_publications    a bot's published numbers, one row per change, with the
--                       numbers it had before. Publicly readable: the brief asks
--                       for a bot's history to be visible, and an audit trail
--                       nobody can see is not a control.
--
-- Applied after 010. Nothing here changes an existing column.

-- ---------------------------------------------------------------------------
-- A frozen account
--
-- profiles already carries self-exclusion (009). A freeze is the operator's own
-- block: the player did not ask for it, and it ends when an operator removes it.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists frozen_until timestamptz;

comment on column public.profiles.frozen_until is
  'When set and in the future, the operator has frozen this account: no bets, no deposits, no withdrawals until it is cleared. Distinct from self-excluded, which the player chose.';

-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  severity text not null default 'warning',
  message text not null,
  context jsonb not null default '{}'::jsonb,
  match_id uuid references public.matches (id) on delete set null,
  user_id uuid references public.profiles (id) on delete set null,
  acknowledged_at timestamptz,
  acknowledged_by text,
  created_at timestamptz not null default now(),
  constraint alerts_code_not_blank_check check (btrim(code) <> ''),
  constraint alerts_message_not_blank_check check (btrim(message) <> ''),
  constraint alerts_severity_check check (severity in ('info', 'warning', 'critical'))
);

comment on table public.alerts is
  'Conditions the operator must see: bankroll below its floor, a settlement that failed, a verification that failed. One row per occurrence, written before the webhook is attempted, so a failed POST never loses the alert.';
comment on column public.alerts.code is
  'What happened, stable enough to filter on: bankroll_low, settlement_failed, verification_failed, health_degraded.';
comment on column public.alerts.context is
  'Everything needed to understand the occurrence without a second query.';
comment on column public.alerts.severity is
  'info, warning or critical. Critical is for money that has moved wrongly or a match that could not be settled.';

create index if not exists alerts_open_idx
  on public.alerts (created_at desc)
  where acknowledged_at is null;

create index if not exists alerts_code_created_idx on public.alerts (code, created_at desc);

alter table public.alerts enable row level security;

-- The API reads alerts with the service role only: an alert names a user or a
-- match, so it is never a public row.
drop policy if exists alerts_service_only on public.alerts;
create policy alerts_service_only on public.alerts
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- market_overrides
-- ---------------------------------------------------------------------------
create table if not exists public.market_overrides (
  id uuid primary key default gen_random_uuid(),
  market_type text not null,
  max_stake_minor bigint,
  margin_bps integer,
  note text,
  updated_by text not null default 'admin',
  updated_at timestamptz not null default now(),
  constraint market_overrides_type_not_blank_check check (btrim(market_type) <> ''),
  constraint market_overrides_max_stake_check
    check (max_stake_minor is null or max_stake_minor > 0),
  constraint market_overrides_margin_check
    check (margin_bps is null or (margin_bps >= 0 and margin_bps <= 5000)),
  constraint market_overrides_type_key unique (market_type),
  constraint market_overrides_has_a_value_check
    check (max_stake_minor is not null or margin_bps is not null)
);

comment on table public.market_overrides is
  'Per-market-type stake ceiling and margin, applied by the next pricing run and by place_bet. One row per market_type; a null column means the platform default still applies, so an override narrows a market and never widens it by accident.';

alter table public.market_overrides enable row level security;

drop policy if exists market_overrides_service_only on public.market_overrides;
create policy market_overrides_service_only on public.market_overrides
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- bot_publications: a bot's numbers, and the numbers it had before
-- ---------------------------------------------------------------------------
create table if not exists public.bot_publications (
  id uuid primary key default gen_random_uuid(),
  bot_id text not null,
  level text not null,
  numbers jsonb not null,
  previous jsonb,
  actor text not null default 'admin',
  created_at timestamptz not null default now(),
  constraint bot_publications_bot_not_blank_check check (btrim(bot_id) <> ''),
  constraint bot_publications_level_check
    check (level in ('rookie', 'club', 'master'))
);

comment on table public.bot_publications is
  'Every change to a bot''s published numbers, newest last, with the numbers it had before. Publicly readable: the brief asks for a bot''s history to be visible, and numbers that can be changed without a visible record are not a control.';
comment on column public.bot_publications.numbers is
  'The published numbers after the change: skill, and whatever else the bot advertises.';
comment on column public.bot_publications.previous is
  'The published numbers before the change. Null for the first publication.';

create index if not exists bot_publications_bot_idx
  on public.bot_publications (bot_id, created_at desc);

alter table public.bot_publications enable row level security;

drop policy if exists bot_publications_public_read on public.bot_publications;
create policy bot_publications_public_read on public.bot_publications
  for select
  to anon, authenticated
  using (true);

drop policy if exists bot_publications_service_write on public.bot_publications;
create policy bot_publications_service_write on public.bot_publications
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- The audit trail, read the way an operator reads it
-- ---------------------------------------------------------------------------
create index if not exists admin_actions_target_idx
  on public.admin_actions (target_type, target_id, created_at desc);

create index if not exists admin_actions_action_created_idx
  on public.admin_actions (action, created_at desc);
