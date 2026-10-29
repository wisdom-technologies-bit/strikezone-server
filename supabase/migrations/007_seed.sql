-- 007_seed.sql
--
-- Baseline rows: the house account, the escrow account and six labelled bots.
-- Safe to re-run: every insert is guarded by a unique index and on conflict do
-- nothing, so no duplicate accounts or bots are created.

begin;

-- ---------------------------------------------------------------------------
-- House and escrow accounts, one of each per currency
-- ---------------------------------------------------------------------------
insert into public.wallet_accounts (owner_type, user_id, currency)
values
  ('house', null, 'NGN'),
  ('escrow', null, 'NGN')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Bots: three carrom skill levels and three ludo policies
-- ---------------------------------------------------------------------------
-- skill holds the numbers the odds simulator and the bot use; bot_policy names
-- the strategy implementation. Both are deliberately plain JSON so they can be
-- retuned without a migration.
insert into public.players (kind, profile_id, display_name, bot_policy, skill, rating)
values
  (
    'bot',
    null,
    'Carrom Beginner',
    'carrom_beginner',
    '{"aim_noise_deg": 4.0, "power_noise_pct": 12, "planning_depth": 1, "pocket_bias": 0.2}'::jsonb,
    1000
  ),
  (
    'bot',
    null,
    'Carrom Intermediate',
    'carrom_intermediate',
    '{"aim_noise_deg": 1.5, "power_noise_pct": 5, "planning_depth": 2, "pocket_bias": 0.5}'::jsonb,
    1200
  ),
  (
    'bot',
    null,
    'Carrom Expert',
    'carrom_expert',
    '{"aim_noise_deg": 0.4, "power_noise_pct": 1.5, "planning_depth": 3, "pocket_bias": 0.8}'::jsonb,
    1400
  ),
  (
    'bot',
    null,
    'Ludo Cautious',
    'ludo_cautious',
    '{"aggression": 0.2, "capture_bias": 0.9, "spawn_bias": 0.4, "risk_tolerance": 0.2}'::jsonb,
    1100
  ),
  (
    'bot',
    null,
    'Ludo Balanced',
    'ludo_balanced',
    '{"aggression": 0.5, "capture_bias": 0.6, "spawn_bias": 0.6, "risk_tolerance": 0.5}'::jsonb,
    1200
  ),
  (
    'bot',
    null,
    'Ludo Aggressive',
    'ludo_aggressive',
    '{"aggression": 0.9, "capture_bias": 0.7, "spawn_bias": 0.9, "risk_tolerance": 0.8}'::jsonb,
    1300
  )
on conflict do nothing;

commit;
