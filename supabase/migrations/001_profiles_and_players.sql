-- 001_profiles_and_players.sql
--
-- Profiles (one per authenticated user) and players (humans and bots).
-- No money columns in this file.
--
-- Safe to run once on a fresh database, and safe to re-run: every object is
-- created conditionally and every constraint is named.

begin;

-- ---------------------------------------------------------------------------
-- profiles: the application-side record for an auth.users row
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  display_name text,
  role text not null default 'user',
  kyc_status text not null default 'none',
  self_excluded_until timestamptz,
  created_at timestamptz not null default now(),
  constraint profiles_username_key unique (username),
  constraint profiles_role_check check (role in ('user', 'admin')),
  constraint profiles_kyc_status_check
    check (kyc_status in ('none', 'pending', 'verified', 'rejected')),
  constraint profiles_username_not_blank_check check (btrim(username) <> '')
);

comment on table public.profiles is
  'One row per authenticated user. id is the auth.users id: there is no separate profile identifier.';
comment on column public.profiles.username is
  'Public handle, unique across the site. Immutable by convention once players know it.';
comment on column public.profiles.display_name is
  'Name shown next to the username. Falls back to username when null.';
comment on column public.profiles.role is
  'user or admin. Admin is a server-side privilege; it is never trusted from the browser.';
comment on column public.profiles.kyc_status is
  'Identity verification state: none, pending, verified or rejected.';
comment on column public.profiles.self_excluded_until is
  'When set and in the future, the user must be refused new bets and entries. Null means no self-exclusion.';
comment on column public.profiles.created_at is
  'When the profile row was created.';

-- ---------------------------------------------------------------------------
-- players: participants in a match, human or bot
-- ---------------------------------------------------------------------------
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'human',
  profile_id uuid references public.profiles (id) on delete set null,
  display_name text not null,
  is_bot boolean generated always as (kind = 'bot') stored,
  bot_policy text,
  skill jsonb not null default '{}'::jsonb,
  rating numeric,
  created_at timestamptz not null default now(),
  constraint players_kind_check check (kind in ('human', 'bot')),
  constraint players_bot_has_no_profile_check check (kind <> 'bot' or profile_id is null),
  constraint players_bot_has_policy_check check (kind <> 'bot' or bot_policy is not null),
  constraint players_display_name_not_blank_check check (btrim(display_name) <> ''),
  constraint players_rating_check check (rating is null or rating >= 0)
);

comment on table public.players is
  'Match participants. A human player points at a profile; a bot has no profile and always has is_bot true so the site can label it.';
comment on column public.players.kind is
  'human or bot. Drives is_bot.';
comment on column public.players.profile_id is
  'The owning profile for a human player. Always null for a bot.';
comment on column public.players.is_bot is
  'Generated from kind, so a bot can never be presented as a human.';
comment on column public.players.bot_policy is
  'Named bot strategy (for example ludo_aggressive). Required for bots, null for humans.';
comment on column public.players.skill is
  'Measured skill numbers for this player as JSON, for example aim noise or policy weights. Read by the odds simulator.';
comment on column public.players.rating is
  'Rating used for matchmaking and seeding. Null until the first rated match.';
comment on column public.players.created_at is
  'When the player row was created.';

-- A human profile owns at most one player row; bots are not covered.
create unique index if not exists players_profile_id_key
  on public.players (profile_id)
  where profile_id is not null;

-- Bot labels are unique so the site can rely on a stable set of named bots.
create unique index if not exists players_bot_display_name_key
  on public.players (display_name)
  where kind = 'bot';

create index if not exists players_kind_idx on public.players (kind);

commit;
