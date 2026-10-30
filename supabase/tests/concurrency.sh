#!/usr/bin/env bash
# concurrency.sh
#
# One hundred simultaneous bets on the same selection, from one hundred
# different players, against a house with a deliberately small free bankroll.
#
# The point is the cap, not the first answer: whatever the interleaving, the
# match's exposure after the storm must be at or below MATCH_EXPOSURE_PCT of the
# free bankroll, and the number of accepted bets must be the one the cap allows.
#
#   supabase/tests/run.sh                 # build and check the database first
#   supabase/tests/concurrency.sh         # then storm it
#
# Needs psql and a database that run.sh has already built.
set -euo pipefail

db="${1:-strikezone_verify}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
bets=100

psql -q -v ON_ERROR_STOP=1 -d "${db}" <<'SQL'
-- A match, one market and a house with 1,000,000 kobo of free cash. Each bet is
-- 20,000 at 2.00, so each accepted bet adds 20,000 of exposure and the 20% cap
-- is 200,000: exactly ten bets fit, however they are ordered.
insert into matches (id, game, status, started_at) values
  ('d0000000-0000-4000-8000-000000000001', 'carrom', 'live', now())
on conflict (id) do nothing;

insert into markets (id, match_id, market_type, subject, line, selection_key, fair_probability, odds_decimal, max_stake_minor) values
  ('d0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'match_winner', '', null, 'x', 0.5, 2.0, 100000)
on conflict (id) do update set status = 'open', odds_decimal = 2.0, max_stake_minor = 100000;

delete from bets where market_id = 'd0000000-0000-4000-8000-000000000002';

-- One hundred players, each with their own wallet and 100,000 kobo.
do $$
declare
  v_index integer;
  v_user uuid;
  v_house uuid := (select id from wallet_accounts where owner_type = 'house' and currency = 'NGN');
  v_balance bigint;
begin
  for v_index in 1..100 loop
    v_user := ('e0000000-0000-4000-8000-' || lpad(v_index::text, 12, '0'))::uuid;

    insert into auth.users (id, email) values (v_user, 'storm' || v_index || '@example.test')
    on conflict do nothing;

    insert into profiles (id, username, display_name)
    values (v_user, 'storm' || v_index, 'Storm ' || v_index)
    on conflict (id) do nothing;

    insert into wallet_accounts (owner_type, user_id, currency)
    values ('user', v_user, 'NGN')
    on conflict do nothing;

    perform post_ledger_transaction(
      'storm-fund-' || v_index,
      'deposit',
      'test',
      null,
      jsonb_build_array(
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'user' and user_id = v_user)::text, 'amount_minor', 100000),
        jsonb_build_object('account_id', v_house::text, 'amount_minor', -100000)
      )
    );
  end loop;

  -- Reset the house to 1,000,000 kobo of free cash, so the cap is 200,000.
  select balance_minor into v_balance from account_balances where account_id = v_house;
  if v_balance > 1000000 then
    perform post_ledger_transaction(
      'storm-drain',
      'adjustment',
      'test',
      null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_house::text, 'amount_minor', -(v_balance - 1000000)),
        jsonb_build_object('account_id', (select id from wallet_accounts where owner_type = 'treasury' and currency = 'NGN')::text, 'amount_minor', v_balance - 1000000)
      )
    );
  end if;
end $$;
SQL

# Before the storm: the house's cash, and the exposure it already carries on
# other matches. The cap is a fifth of the bankroll that is free, and that free
# bankroll shrinks as bets are accepted, so the arithmetic below has to include
# the feedback or it would expect more bets than the rule allows.
house_cash="$(psql -q -tA -d "${db}" -c "select public.free_bankroll_minor('NGN') + public.exposure_minor(null, null)")"
other_exposure="$(psql -q -tA -d "${db}" -c "select public.exposure_minor(null, null) - public.match_exposure_minor('d0000000-0000-4000-8000-000000000001', null)")"
per_bet=20000

echo "firing ${bets} simultaneous bets"
for index in $(seq 1 "${bets}"); do
  user="e0000000-0000-4000-8000-$(printf '%012d' "${index}")"
  psql -q -tA -d "${db}" -c \
    "select public.place_bet('${user}'::uuid, 'd0000000-0000-4000-8000-000000000002'::uuid, 20000, 2.0, 'storm-bet-${index}', 100, 20, false) ->> 'code'" \
    >"/tmp/storm-${index}.out" 2>&1 &
done
wait

accepted=0
refused_cap=0
other=0
for index in $(seq 1 "${bets}"); do
  outcome="$(tr -d '\n' <"/tmp/storm-${index}.out")"
  case "${outcome}" in
    "") accepted=$((accepted + 1)) ;;
    match_exposure_cap | global_exposure_cap) refused_cap=$((refused_cap + 1)) ;;
    *) other=$((other + 1)); echo "unexpected outcome ${index}: ${outcome}" ;;
  esac
done

open_bets="$(psql -q -tA -d "${db}" -c "select count(*) from bets where market_id = 'd0000000-0000-4000-8000-000000000002' and status = 'open'")"
exposure="$(psql -q -tA -d "${db}" -c "select public.match_exposure_minor('d0000000-0000-4000-8000-000000000001', null)")"
free_now="$(psql -q -tA -d "${db}" -c "select public.free_bankroll_minor('NGN')")"

# The rule as place_bet applies it: the k-th bet is accepted when
#   k*p <= 0.2 * (H - O - (k-1)*p)
# which rearranges to the largest k below.
expected="$(python3 -c "import math; H=${house_cash}; O=${other_exposure}; p=${per_bet}; print(int((0.2*(H-O) + 0.2*p) // (1.2*p)))")"

echo "accepted ${accepted}, refused by cap ${refused_cap}, unexpected ${other}"
echo "open bets ${open_bets}, exposure ${exposure}, free bankroll now ${free_now}"
echo "house cash ${house_cash}, other exposure ${other_exposure}, the cap allows ${expected}"

if [ "${other}" -ne 0 ]; then
  echo "FAIL: ${other} bets failed for a reason other than the cap"
  exit 1
fi
if [ "${open_bets}" -ne "${accepted}" ]; then
  echo "FAIL: ${open_bets} open bets but ${accepted} accepted"
  exit 1
fi
if [ "${exposure}" -ne "$((accepted * per_bet))" ]; then
  echo "FAIL: exposure ${exposure} is not ${accepted} bets of ${per_bet}"
  exit 1
fi
if [ "${accepted}" -ne "${expected}" ]; then
  echo "FAIL: ${accepted} bets were accepted where the cap allows ${expected}"
  exit 1
fi
if [ "$((exposure * 12))" -gt "$((2 * (house_cash - other_exposure) + 2 * accepted * per_bet))" ]; then
  echo "FAIL: exposure ${exposure} broke the cap while the storm was running"
  exit 1
fi

echo "PASS: ${accepted} of ${bets} accepted, exposure ${exposure} stops exactly where the cap says"
