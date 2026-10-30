#!/usr/bin/env bash
# Applies the shim, every migration in order, then verify.sql, against a scratch
# database. Needs a local Postgres and a role that can create databases.
#
#   ./supabase/tests/run.sh            # uses strikezone_verify
#   ./supabase/tests/run.sh other_db
set -euo pipefail

db="${1:-strikezone_verify}"
root="$(cd "$(dirname "$0")/../.." && pwd)"

psql -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists ${db}" >/dev/null
psql -v ON_ERROR_STOP=1 -d postgres -c "create database ${db}" >/dev/null

echo "applying shim (auth schema, Supabase roles, realtime publication)"
psql -q -v ON_ERROR_STOP=1 -d "${db}" -f "${root}/supabase/tests/local_shim.sql"

for file in "${root}"/supabase/migrations/*.sql; do
  echo "applying $(basename "${file}")"
  # No pipe and no || true: a migration that fails must stop the run, not be
  # filtered away as if it had applied.
  psql -q -v ON_ERROR_STOP=1 -d "${db}" -f "${file}"
done

echo "running checks"
psql -q -v ON_ERROR_STOP=1 -d "${db}" -f "${root}/supabase/tests/verify.sql"

echo "running money checks"
psql -q -v ON_ERROR_STOP=1 -d "${db}" -f "${root}/supabase/tests/money.sql"
