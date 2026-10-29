# supabase

Database schema for Strikezone, as numbered SQL migrations. The server never
creates or alters tables: it holds the service role key and only ever reads and
writes rows. These files are applied by a human, in order, once.

## Requirements

- A Supabase project on Postgres 15 or newer. Two features are 15+ only: the
  `nulls not distinct` unique index on `markets`, and `security_invoker` on the
  views.
- The standard Supabase roles (`anon`, `authenticated`, `service_role`), the
  `auth.uid()` function and the `supabase_realtime` publication. All exist in a
  default project.

## Run order

| #   | File                                      | What it creates                                                                                                                                                                      |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `migrations/001_profiles_and_players.sql` | `profiles` (one per `auth.users` row: username, role, KYC state, self-exclusion) and `players` (humans and bots, with `is_bot` generated from `kind` so a bot can never look human). |
| 2   | `migrations/002_wallet_and_ledger.sql`    | `wallet_accounts`, `ledger_transactions`, `ledger_entries`, the append-only triggers, the derived `account_balances` view and `post_ledger_transaction()`, the only way money moves. |
| 3   | `migrations/003_matches_and_events.sql`   | `matches` (game, lifecycle, provably fair seed commit/reveal, signed result, log head), `match_players` (seats), `match_events` (append-only, hash-chained log).                     |
| 4   | `migrations/004_tournaments.sql`          | `tournaments`, `tournament_entries`, `tournament_matches` (the bracket), plus the `matches.tournament_id` foreign key that file 3 could not declare yet.                             |
| 5   | `migrations/005_markets_and_bets.sql`     | `markets` (one row per selection), `bets`, the `touch_updated_at` trigger, and the `open_liability` and `house_bankroll` views the house needs to stay solvent.                      |
| 6   | `migrations/006_security.sql`             | Row level security on every table, the read policies, table and view privileges, and the realtime publication. No write policy exists: the browser never writes.                     |
| 7   | `migrations/007_seed.sql`                 | Baseline rows: the house account, the escrow account in NGN, and six labelled bots (three Carrom skill levels, three Ludo policies).                                                 |

## How to apply

Supabase CLI, from this directory's parent:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or with `psql`, in order, which is what the verification harness does:

```bash
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

Or paste the files into the Supabase SQL editor one at a time, in the order above.

Every file is wrapped in a transaction and creates its objects conditionally, so
re-running a file that has already been applied is a no-op rather than an error.
That is a convenience, not a migration system: once a file has been applied to a
real database, add a new numbered file instead of editing it.

## Verifying

`tests/` holds a throwaway Postgres setup and a behaviour suite, so the rules
below can be checked without touching a real project:

```bash
./supabase/tests/run.sh          # needs a local Postgres; uses strikezone_verify
```

It applies `tests/local_shim.sql` (a stand-in for Supabase's `auth` schema,
roles and realtime publication), then every migration, then `tests/verify.sql`,
which checks 23 things and prints `PASS` for each, including:

- a deposit moves money, its legs sum to zero, and the derived balance is right;
- legs that do not sum to zero, zero or fractional amounts, unknown accounts,
  unknown fields and unknown kinds are all refused, with nothing written;
- an overdraw on a user account is refused;
- a repeated idempotency key returns the original transaction and moves no money
  twice;
- `UPDATE` and `DELETE` are rejected on the ledger and on `match_events`;
- `open_liability` and `house_bankroll` compute the expected numbers;
- an authenticated user sees their own profile, wallet, entries and bets, the
  public list, only finished match events, and no transaction headers;
- an anonymous visitor sees players and finished match events but no profiles
  and no wallets;
- a browser cannot insert a bet or execute `post_ledger_transaction`;
- the realtime publication carries the four expected tables;
- every table, view and function carries a comment.

## Conventions

- **Money is always `bigint` in the smallest unit** (kobo for NGN, coins for
  virtual play). There is no floating point money column anywhere. Odds, lines
  and probabilities are `numeric` because they are ratios.
- **Balances are never stored.** `account_balances` sums `ledger_entries`, and
  `ledger_entries` is append-only. Corrections are compensating transactions.
- **All money moves through `post_ledger_transaction()`**: it writes the
  transaction and its legs atomically, requires the legs to sum to exactly zero,
  refuses to overdraw a user account, and returns the original row when the
  idempotency key has already been used.
- **Every id is a `uuid` from `gen_random_uuid()`, every timestamp is
  `timestamptz` default `now()`**, except where a column is explicitly nullable
  (such as `started_at`, which is null until a match starts).
- **A market is the set of rows sharing `(match_id, market_type, subject, line)`**;
  `selection_key` distinguishes its mutually exclusive selections. Alternative
  winners of a match therefore share one `subject` and differ in
  `selection_key`.

## Decisions to review

1. **Market identity.** Because `subject` is part of a market's identity,
   `open_liability` groups by `(match_id, market_type, subject, line)` and sums
   the worst case of each group. If you model `match_winner` as one subject per
   player, liability will be overstated (it would treat both players as separate
   markets). The documented convention is that alternatives share `subject = ''`
   and differ in `selection_key`. Say the word and I will change the grouping.
2. **`open_liability` is an upper bound.** Selections in different markets of
   the same match are correlated by the game outcome, and this schema does not
   model joint outcomes, so the per-market worst cases are summed. It errs on the
   safe side for the house but is not the exact worst case.
3. **`house_bankroll` has a `currency` column**, so it returns one row per house
   currency. Amounts in different currencies must never be added, and the three
   columns you specified would have forced exactly that. Open liability carries
   no currency because bets do not store one; it is treated as platform currency.
4. **`winner_to_slot` is an `int`**: the slot in `round + 1` that the winner of
   this position advances to. If you would rather point at the next
   `tournament_matches` row directly, it should become a `uuid` foreign key
   instead. Easy to change now, awkward later.
5. **`matches.tournament_id` gets its foreign key in file 4**, because `003`
   runs before `tournaments` exists. The column is a plain `uuid` in file 3.
6. **Only user accounts are protected from going negative.** House, escrow and
   prize_pool accounts can go negative, which is how escrow holding other
   people's money and a house that has paid out more than it holds both appear.
   If you want the house account to be blocked from going below zero, that is a
   one-line change in `post_ledger_transaction`.
7. **One leg per account per transaction** (`unique (transaction_id, account_id)`),
   so a transaction stores net movements rather than repeated legs on the same
   account.
8. **`post_ledger_transaction` is service-role only.** Execute is revoked from
   `public`, `anon` and `authenticated`, so a browser cannot move money even if a
   policy were added by mistake. It also locks the touched accounts
   (`select ... for update` in id order) so concurrent postings cannot race the
   overdraw check.
9. **No currency on matches, tournaments, markets or bets.** Cross-currency
   betting is not modelled; everything is assumed to be in the platform currency
   (`NGN` in the seed). Adding a currency to bets later would be a new migration.
10. **Seed data is NGN only**: one house and one escrow account. Prize-pool
    accounts are not seeded, and more than one per currency is allowed (one per
    tournament), unlike house and escrow which are unique per currency.
11. **Bot numbers are placeholders.** Names, `bot_policy` strings, the `skill`
    JSON and the ratings (1000 to 1400) are there so the labelling and the odds
    simulator have something to read. They are expected to be retuned, and
    retuning needs no migration because `skill` is JSON.
12. **Extra guards I added:** `bets.settled_at` must be set exactly when the bet
    is not `open`; `matches.seed_reveal` may only exist for `finished` or `void`
    matches; a `live` match must have `started_at`; `ended_at >= started_at`;
    `match_events.seq >= 1` with `unique (match_id, seq)`; a bot must have a
    `bot_policy`; one player row per profile; bot display names are unique.
13. **`ledger_transactions` is not readable by browsers at all** (no policy, no
    grant). Users see their own money movements through `ledger_entries`, which
    is what the wallet history screen needs. If you want transaction headers too,
    it needs a policy that joins through the entries.
14. **`match_events` of a live match are hidden.** Exposing the live log to
    anonymous visitors would leak the board and, with it, the seed. Only
    `finished` matches are public. If the site needs live event commentary, that
    should be a server-rendered payload that omits what must stay secret.
15. **Realtime is added without changing replica identity.** `markets`,
    `matches`, `tournament_matches` and `bets` are in the publication; RLS still
    filters what a subscriber receives. If you want `DELETE` payloads to carry
    full old rows, that needs `replica identity full` on those tables.
16. **No `updated_at` on tables you did not ask for.** Only `markets` has it, with
    a trigger. Profiles, bets and matches carry their own explicit timestamps
    instead.
