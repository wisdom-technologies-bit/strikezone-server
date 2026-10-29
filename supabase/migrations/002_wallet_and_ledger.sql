-- 002_wallet_and_ledger.sql
--
-- Wallet accounts and the append-only ledger. Every money amount in this file
-- is a bigint count of the smallest unit (kobo for NGN, coins for virtual play):
-- there is no floating point money column anywhere in this schema.
--
-- All money changes go through post_ledger_transaction(). Balances are never
-- stored and never updated in place: account_balances derives them from
-- ledger_entries, which can only be appended to.

begin;

-- ---------------------------------------------------------------------------
-- wallet_accounts
-- ---------------------------------------------------------------------------
create table if not exists public.wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null,
  user_id uuid references public.profiles (id) on delete restrict,
  currency text not null default 'NGN',
  created_at timestamptz not null default now(),
  constraint wallet_accounts_owner_type_check
    check (owner_type in ('user', 'house', 'escrow', 'prize_pool')),
  constraint wallet_accounts_currency_format_check
    check (currency ~ '^[A-Z]{3}$'),
  constraint wallet_accounts_user_owner_check
    check (
      (owner_type = 'user' and user_id is not null)
      or (owner_type <> 'user' and user_id is null)
    )
);

comment on table public.wallet_accounts is
  'A named pot of money. Exactly one house account and one escrow account per currency; user accounts belong to a profile.';
comment on column public.wallet_accounts.owner_type is
  'user, house, escrow or prize_pool.';
comment on column public.wallet_accounts.user_id is
  'The owning profile for a user account. Null for house, escrow and prize_pool accounts.';
comment on column public.wallet_accounts.currency is
  'ISO 4217 code. Balances in different currencies must never be added together.';

-- Exactly one house account per currency.
create unique index if not exists wallet_accounts_one_house_per_currency_key
  on public.wallet_accounts (currency)
  where owner_type = 'house';

-- Exactly one escrow account per currency: stakes sit here until a match settles.
create unique index if not exists wallet_accounts_one_escrow_per_currency_key
  on public.wallet_accounts (currency)
  where owner_type = 'escrow';

-- One wallet per user per currency.
create unique index if not exists wallet_accounts_user_currency_key
  on public.wallet_accounts (user_id, currency)
  where owner_type = 'user';

create index if not exists wallet_accounts_owner_type_idx
  on public.wallet_accounts (owner_type, currency);

-- ---------------------------------------------------------------------------
-- ledger_transactions: one row per money movement, identified by idempotency key
-- ---------------------------------------------------------------------------
create table if not exists public.ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  kind text not null,
  ref_type text,
  ref_id uuid,
  created_at timestamptz not null default now(),
  constraint ledger_transactions_idempotency_key_key unique (idempotency_key),
  constraint ledger_transactions_idempotency_key_not_blank_check
    check (btrim(idempotency_key) <> ''),
  constraint ledger_transactions_kind_check
    check (
      kind in (
        'deposit',
        'withdrawal',
        'bet_stake',
        'bet_payout',
        'bet_refund',
        'house_fee',
        'tournament_entry',
        'tournament_prize',
        'bankroll_topup',
        'adjustment'
      )
    )
);

comment on table public.ledger_transactions is
  'One row per money movement. Append-only: updated and deleted rows are rejected by trigger.';
comment on column public.ledger_transactions.idempotency_key is
  'Caller-supplied unique key. Re-posting the same key returns the original transaction instead of moving money twice.';
comment on column public.ledger_transactions.kind is
  'Why money moved: deposit, withdrawal, bet_stake, bet_payout, bet_refund, house_fee, tournament_entry, tournament_prize, bankroll_topup or adjustment.';
comment on column public.ledger_transactions.ref_type is
  'What the transaction is about, for example bet, match, tournament or withdrawal_request. Free text by design.';
comment on column public.ledger_transactions.ref_id is
  'The id of the referenced row. Not a foreign key because ref_type decides the table.';

-- ---------------------------------------------------------------------------
-- ledger_entries: the per-account legs of a transaction
-- ---------------------------------------------------------------------------
create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.ledger_transactions (id) on delete restrict,
  account_id uuid not null references public.wallet_accounts (id) on delete restrict,
  amount_minor bigint not null,
  created_at timestamptz not null default now(),
  constraint ledger_entries_amount_minor_not_zero_check check (amount_minor <> 0),
  constraint ledger_entries_transaction_account_key unique (transaction_id, account_id)
);

comment on table public.ledger_entries is
  'The legs of a transaction. amount_minor is signed: credits are positive, debits are negative. The legs of a transaction always sum to zero.';
comment on column public.ledger_entries.amount_minor is
  'Signed amount in the smallest unit of the account currency. Never floating point.';
comment on column public.ledger_entries.account_id is
  'The wallet account this leg affects. An account appears at most once per transaction.';

create index if not exists ledger_entries_account_id_idx
  on public.ledger_entries (account_id);
create index if not exists ledger_entries_transaction_id_idx
  on public.ledger_entries (transaction_id);

-- ---------------------------------------------------------------------------
-- account_balances: balances are derived, never stored
-- ---------------------------------------------------------------------------
create or replace view public.account_balances
with (security_invoker = true) as
select
  a.id as account_id,
  coalesce(sum(e.amount_minor), 0)::bigint as balance_minor
from public.wallet_accounts a
left join public.ledger_entries e on e.account_id = a.id
group by a.id;

comment on view public.account_balances is
  'Derived balance per wallet account: the sum of its ledger entries. Accounts with no entries report 0. security_invoker is on, so a browser session only sees accounts it is allowed to read.';

-- ---------------------------------------------------------------------------
-- post_ledger_transaction: the only way money moves
-- ---------------------------------------------------------------------------
create or replace function public.post_ledger_transaction(
  p_idempotency_key text,
  p_kind text,
  p_ref_type text default null,
  p_ref_id uuid default null,
  p_entries jsonb default '[]'::jsonb
) returns public.ledger_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry jsonb;
  v_amount bigint;
  v_total numeric := 0;
  v_account_id uuid;
  v_known_accounts integer;
  v_distinct_accounts integer;
  v_entry_count integer;
  v_existing public.ledger_transactions;
  v_transaction public.ledger_transactions;
begin
  -- 1. Replay: an idempotency key that has been used returns its original row.
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'post_ledger_transaction: idempotency_key is required'
      using errcode = '22023';
  end if;

  select t.* into v_existing
  from public.ledger_transactions t
  where t.idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  -- 2. Validate the transaction header.
  if p_kind is null or p_kind not in (
    'deposit',
    'withdrawal',
    'bet_stake',
    'bet_payout',
    'bet_refund',
    'house_fee',
    'tournament_entry',
    'tournament_prize',
    'bankroll_topup',
    'adjustment'
  ) then
    raise exception 'post_ledger_transaction: unsupported kind %', coalesce(p_kind, '<null>')
      using errcode = '22023';
  end if;

  if p_ref_type is not null and btrim(p_ref_type) = '' then
    raise exception 'post_ledger_transaction: ref_type must be null or non-blank'
      using errcode = '22023';
  end if;

  if p_entries is null
     or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) = 0 then
    raise exception 'post_ledger_transaction: entries must be a non-empty JSON array'
      using errcode = '22023';
  end if;

  -- 3. Validate every leg before writing anything: shape, integral amount,
  --    non-zero, known account.
  for v_entry in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(v_entry) <> 'object' then
      raise exception 'post_ledger_transaction: each entry must be a JSON object'
        using errcode = '22023';
    end if;

    if exists (
      select 1 from jsonb_object_keys(v_entry) as k
      where k not in ('account_id', 'amount_minor')
    ) then
      raise exception 'post_ledger_transaction: unknown entry field in %', v_entry
        using errcode = '22023';
    end if;

    if not (v_entry ? 'account_id') or not (v_entry ? 'amount_minor') then
      raise exception 'post_ledger_transaction: each entry needs account_id and amount_minor'
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_entry -> 'account_id') <> 'string' then
      raise exception 'post_ledger_transaction: account_id must be a uuid string'
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_entry -> 'amount_minor') <> 'number'
       or (v_entry ->> 'amount_minor') !~ '^-?[0-9]{1,18}$' then
      raise exception 'post_ledger_transaction: amount_minor must be an integer (got %)',
        v_entry ->> 'amount_minor'
        using errcode = '22023';
    end if;

    v_amount := (v_entry ->> 'amount_minor')::bigint;

    if v_amount = 0 then
      raise exception 'post_ledger_transaction: an entry amount cannot be zero'
        using errcode = '22023';
    end if;

    v_account_id := (v_entry ->> 'account_id')::uuid;

    perform 1 from public.wallet_accounts a where a.id = v_account_id;
    if not found then
      raise exception 'post_ledger_transaction: unknown account %', v_account_id
        using errcode = '23503';
    end if;

    v_total := v_total + v_amount;
  end loop;

  -- 4. The legs must balance exactly. Money is never created or destroyed here.
  if v_total <> 0 then
    raise exception 'post_ledger_transaction: entries must sum to zero, got %', v_total
      using errcode = '23514';
  end if;

  -- 5. An account may appear once per transaction: the ledger stores one net leg.
  select
    count(*),
    count(distinct (value ->> 'account_id'))
  into v_entry_count, v_distinct_accounts
  from jsonb_array_elements(p_entries);

  if v_entry_count <> v_distinct_accounts then
    raise exception 'post_ledger_transaction: an account may appear only once per transaction'
      using errcode = '22023';
  end if;

  -- 6. Serialise concurrent postings on the same accounts so the overdraft check
  --    below cannot be raced. Rows are locked in id order to avoid deadlocks.
  perform 1
  from public.wallet_accounts a
  where a.id in (
    select (value ->> 'account_id')::uuid from jsonb_array_elements(p_entries)
  )
  order by a.id
  for update;

  select count(*) into v_known_accounts
  from public.wallet_accounts a
  where a.id in (
    select (value ->> 'account_id')::uuid from jsonb_array_elements(p_entries)
  );

  if v_known_accounts <> v_distinct_accounts then
    raise exception 'post_ledger_transaction: unknown account in entries'
      using errcode = '23503';
  end if;

  -- 7. Write the header, then the legs.
  begin
    insert into public.ledger_transactions (idempotency_key, kind, ref_type, ref_id)
    values (p_idempotency_key, p_kind, p_ref_type, p_ref_id)
    returning * into v_transaction;
  exception when unique_violation then
    -- A concurrent caller with the same key won the race: return its row.
    select t.* into v_existing
    from public.ledger_transactions t
    where t.idempotency_key = p_idempotency_key;

    if v_existing.id is null then
      raise;
    end if;

    return v_existing;
  end;

  insert into public.ledger_entries (transaction_id, account_id, amount_minor)
  select
    v_transaction.id,
    (value ->> 'account_id')::uuid,
    (value ->> 'amount_minor')::bigint
  from jsonb_array_elements(p_entries);

  -- 8. A user account may not be overdrawn. House, escrow and prize_pool accounts
  --    are not restricted: escrow legitimately holds other people's money.
  if exists (
    select 1
    from public.wallet_accounts a
    join public.account_balances b on b.account_id = a.id
    where a.owner_type = 'user'
      and b.balance_minor < 0
      and a.id in (
        select (value ->> 'account_id')::uuid from jsonb_array_elements(p_entries)
      )
  ) then
    raise exception 'post_ledger_transaction: insufficient funds for user account'
      using errcode = '23514';
  end if;

  return v_transaction;
end;
$$;

comment on function public.post_ledger_transaction(text, text, text, uuid, jsonb) is
  'Posts one balanced, append-only money movement. Writes the transaction and its entries atomically, rejects legs that do not sum to zero, rejects unknown accounts and unknown fields, prevents an overdraw on user accounts, and returns the existing transaction when the idempotency key has already been used.';

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
create or replace function public.reject_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'append-only table %: % is not allowed', tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

comment on function public.reject_mutation() is
  'Trigger function that rejects UPDATE and DELETE on ledger tables. Money history is corrected with a compensating transaction, never by editing it.';

drop trigger if exists ledger_transactions_append_only on public.ledger_transactions;
create trigger ledger_transactions_append_only
  before update or delete on public.ledger_transactions
  for each statement execute function public.reject_mutation();

drop trigger if exists ledger_entries_append_only on public.ledger_entries;
create trigger ledger_entries_append_only
  before update or delete on public.ledger_entries
  for each statement execute function public.reject_mutation();

commit;
