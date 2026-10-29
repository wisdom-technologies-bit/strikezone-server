# supabase/migrations

Numbered SQL migration files, applied by a human. The server never creates or
alters tables from code (AI_RULES.md).

Naming: `NNNN_short_description.sql`, zero padded and increasing, for example
`0001_create_wallet_ledger.sql`. Files are append-only: never edit a migration
that has been applied, add a new one.

Every migration should be safe to re-run where practical (`create table if not
exists`, `create index if not exists`) and must include its grants and row level
security policies. Money columns are integers in the smallest unit (kobo or
coins) with a `check (amount <> 0)` style guard, never floating point.
