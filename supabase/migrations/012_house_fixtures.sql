-- 012_house_fixtures.sql
--
-- The one row the house fixture scheduler needs of its own.
--
-- The fixtures themselves are not a new table: a fixture is an ordinary match,
-- so it lives in `matches` and `match_players` with the same columns, the same
-- room, the same prices and the same settlement as any other. What has nowhere
-- else to live is the pause switch. It has to mean the same thing to both
-- instances, survive a restart, and be readable by the operator API, so it is a
-- row rather than an environment variable.
--
-- Applied after 011. Nothing here changes an existing column or table.
--
-- Without this migration the scheduler still runs: a missing table reads as "not
-- paused", which is the state a project with no pause switch must be in, and it
-- logs that the migration is outstanding the first time it looks.

-- ---------------------------------------------------------------------------
-- fixture_controller: exactly one row
-- ---------------------------------------------------------------------------
create table if not exists public.fixture_controller (
  id smallint primary key,
  paused boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint fixture_controller_single_row_check check (id = 1)
);

comment on table public.fixture_controller is
  'One row: whether the house is creating new fixtures. A pause stops new matches being scheduled; it never touches a match already in play.';

comment on column public.fixture_controller.paused is
  'When true the scheduler creates nothing new. Fixtures already scheduled still start, because people may have bet on them.';

comment on column public.fixture_controller.updated_by is
  'The operator name from x-admin-actor, so a pause has a person behind it in the audit log and in this row.';

insert into public.fixture_controller (id, paused)
values (1, false)
on conflict (id) do nothing;

alter table public.fixture_controller enable row level security;

-- Operator state, held by the server: the scheduler reads it with the service
-- role and the API writes it there. Never a public row.
drop policy if exists fixture_controller_service_only on public.fixture_controller;
create policy fixture_controller_service_only on public.fixture_controller
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.fixture_controller from anon, authenticated;
grant select, insert, update on public.fixture_controller to service_role;
