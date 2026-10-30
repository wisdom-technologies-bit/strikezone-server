# strikezone-server

Game and betting server for **Strikezone**, an online skill-game betting platform
(Carrom first, then Ludo).

The rules that govern all work in this repository live in [AI_RULES.md](./AI_RULES.md).
Read them before changing anything.

## Stack

| Concern    | Choice                                                          |
| ---------- | --------------------------------------------------------------- |
| Language   | TypeScript (strict), Node 22+                                   |
| Realtime   | Colyseus rooms over WebSocket, on the same HTTP server          |
| HTTP       | Express                                                         |
| Database   | Supabase Postgres, service role key via `@supabase/supabase-js` |
| Validation | zod                                                             |
| Logging    | pino (structured, redacting)                                    |
| Tests      | Vitest (+ supertest for HTTP)                                   |
| Tooling    | ESLint (flat config), Prettier                                  |

## Getting started

```bash
npm install
cp .env.example .env     # then fill in every value
npm run dev
```

The server refuses to start when a required variable is missing and prints which
one, for example:

```
[strikezone-server] refusing to start.
Environment configuration is invalid:
  - SUPABASE_URL is missing
  - ADMIN_API_KEY: must be at least 24 characters

Copy .env.example to .env and fill in every value (see README.md).
```

## Scripts

| Script                             | What it does                                        |
| ---------------------------------- | --------------------------------------------------- |
| `npm run dev`                      | `tsx watch` on `src/index.ts` (restarts on change)  |
| `npm run build`                    | Type-check and compile `src` to `dist`              |
| `npm start`                        | Run the compiled server from `dist`                 |
| `npm test`                         | Vitest, single run                                  |
| `npm run test:watch`               | Vitest in watch mode                                |
| `npm run lint`                     | ESLint                                              |
| `npm run format`                   | Prettier write                                      |
| `npm run typecheck`                | `tsc --noEmit` over sources and tests               |
| `npm run verify-match -- <id>`     | Re-check a finished match from the database         |
| `npm run carrom:watch -- <roomId>` | Spectate a live room from the terminal              |
| `npm run odds:calibrate`           | Re-measure the Carrom shot table                    |
| `npm run odds:validate`            | Fast odds model against the real engine             |
| `npm run odds:backtest`            | Score the model against finished matches            |
| `npm run tournament:demo`          | Create, play out and print a whole tournament       |
| `npm run money:demo`               | Top up, bet, settle and reconcile, in memory        |
| `npm run ludo:demo`                | Play a four bot Ludo match and verify it            |
| `npm run ludo:watch`               | Run the server on an in-memory store for the viewer |
| `npm run ludo:bench`               | Measure the Ludo engine and the simulator           |
| `npm run contract:check`           | Compile the contract file on its own                |

## Environment variables

Every value is read through `src/lib/env.ts` and validated with zod. Nothing is
hard-coded and nothing is logged.

| Variable                    | Required | Default   | Notes                                                           |
| --------------------------- | -------- | --------- | --------------------------------------------------------------- |
| `NODE_ENV`                  | yes      | -         | `development`, `test` or `production`                           |
| `PORT`                      | yes      | -         | Shared by the HTTP API and the Colyseus WebSocket server        |
| `SITE_ORIGIN`               | yes      | -         | The website's URL; the only allowed CORS and WebSocket origin   |
| `SUPABASE_URL`              | yes      | -         | Supabase project URL                                            |
| `SUPABASE_SERVICE_ROLE_KEY` | yes      | -         | Bypasses RLS. Server-side only, never shipped to a client       |
| `RESULT_SIGNING_SECRET`     | yes      | -         | Signs match results (>= 32 chars)                               |
| `ADMIN_API_KEY`             | yes      | -         | Authenticates admin API calls (>= 24 chars)                     |
| `MONEY_MODE`                | yes      | -         | `virtual` or `real`                                             |
| `CURRENCY`                  | no       | `NGN`     | ISO 4217 code; NGN amounts are integers in kobo                 |
| `HOUSE_MARGIN_BPS`          | no       | `600`     | Basis points, so 600 = 6.00%                                    |
| `MIN_STAKE_MINOR`           | no       | `100`     | Smallest stake, in minor units                                  |
| `MATCH_EXPOSURE_PCT`        | no       | `20`      | How much of the free bankroll one match may risk, in percent    |
| `LARGE_PAYOUT_MINOR`        | no       | `5000000` | A payout above this waits for an operator before it is paid     |
| `MIN_ACCOUNT_AGE_HOURS`     | no       | `24`      | Account age required before a real-money withdrawal             |
| `BET_RATE_LIMIT_PER_MINUTE` | no       | `10`      | Bets one player may place in a minute (mirrored in `place_bet`) |

In development `http://localhost:3000` is allowed in addition to `SITE_ORIGIN`,
so the website can run locally against this server.

## HTTP endpoints

The public and player-facing routes are documented one by one in
[docs/api.md](docs/api.md), with examples.

| Endpoint                                                      | Status                      | Response                                                           |
| ------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `GET /health`                                                 | 200 while running           | `{ "ok": true, "version": "0.1.0", "uptimeSeconds": 42 }`          |
| `GET /ready`                                                  | 200 when ready, 503         | `{ "ok": true, "checks": { "draining": "up", "supabase": "up" } }` |
| `GET /api/bots`                                               | 200                         | The bot catalogue: level, name, policy id, numbers                 |
| `GET /api/matches/:id/replay`                                 | 200, 404                    | Seats, hash-chained events, chain check, result                    |
| `GET /api/matches/:id/markets`                                | 200                         | Every market of a match, grouped by market type                    |
| `POST /dev/start-match`                                       | 201, 400 (development only) | `{ matchId, roomId, seedCommit, seats }`                           |
| `POST /api/bets`                                              | 201, 400, 409, 429          | The placed bet, its payout, the balance left                       |
| `GET /api/me/bets`                                            | 200                         | The caller's own bets, newest first                                |
| `POST /api/me/self-exclude`                                   | 200, 400                    | `{ until, kind }`; play and deposits are blocked until then        |
| `GET`/`PUT /api/me/limits`                                    | 200, 400                    | Limits in force, and any change waiting out its 24 hours           |
| `POST /api/deposits`                                          | 201, 409                    | The deposit row, a redirect URL when the provider hosts checkout   |
| `GET`/`POST /api/withdrawals`                                 | 200/201, 409                | Request a withdrawal; the money moves to the hold account          |
| `POST /api/webhooks/payments/:provider`                       | 200, 400                    | Signature-verified, replay-safe provider callback                  |
| `POST /api/admin/bankroll/topup`                              | 201, 400                    | Moves operator cash into the house through the ledger              |
| `GET /api/admin/solvency`                                     | 200                         | What players hold, what is owed, exposure, free bankroll           |
| `POST /api/admin/solvency/snapshot`                           | 201                         | Stores reported cash next to liabilities, and the gap              |
| `GET /api/admin/reconcile`                                    | 200                         | Every accounting invariant, with the differences that must be zero |
| `GET /api/admin/bets/pending-review`                          | 200                         | Payouts held for an operator                                       |
| `POST /api/admin/bets/:id/approve`\|`/reject`                 | 200, 404, 409               | Release or refuse a held payout                                    |
| `POST /api/admin/withdrawals/:id/approve`\|`/paid`\|`/reject` | 200, 404, 409               | The three withdrawal decisions                                     |
| `GET`/`POST /api/admin/betting`                               | 200, 400                    | The global betting switch                                          |
| `POST /api/admin/markets/:id/suspend`                         | 200, 404                    | Suspend or reopen one selection                                    |
| `GET /api/admin/audit`                                        | 200                         | The audit trail, newest first                                      |

`/health` never touches the database, so a database outage does not restart an
otherwise healthy process. `/ready` runs the Supabase connection test (a
PostgREST root request, which needs no table to exist yet) and also reports 503
once a shutdown has begun, so a load balancer stops sending new matches to a
draining instance.

The Colyseus WebSocket endpoint shares the same port and the same HTTP server.
Upgrade requests from any origin other than the allowlist are rejected with 403
before the handshake.

## Watching a match

A spectator joins the Carrom room as `{ spectate: true }`, anonymously if it
likes, and receives the state and then every shot:

```js
const room = await client.joinById(matchId, { spectate: true });
room.onMessage("*", (type, payload) => {
  /* welcome, snapshot, shot, match_end */
});
```

Each shot carries the referee's events, the state after it, and a recording of
every body's position at 30 fps, quantised to unsigned 16-bit over the board's
740 mm span and base64 encoded: 16 bytes per four-body frame instead of about 64.
The decoder lives beside the encoder in `src/api/contract.ts`, which the website
copies as it is and which compiles on its own with `npm run contract:check`.

Two things make the stream safe to expose:

- **Fairness.** `shot.received` is published when a shot is accepted, before the
  simulation runs, so the odds engine can suspend the market before any frame of
  that shot exists, let alone leaves the server. That ordering is a test, not a
  comment.
- **Backpressure.** A viewer whose socket has more than a megabyte waiting is
  skipped rather than buffered: it is told it fell behind and sent one fresh
  snapshot instead of the frames it missed. A slow phone cannot slow the room, and
  the tests drive exactly that viewer.

Limits come from configuration: `MAX_SPECTATORS_PER_ROOM` (default 2000) and
`SPECTATOR_JOIN_PER_MINUTE` (default 60, per address).

In development, start the server and open `/dev/watch.html`: press start and a bot
match plays out on a canvas. For Ludo, open `/dev/ludo.html` (or run
`npm run ludo:watch`, which needs no database at all) and press "Start a four bot
match": the page draws the ring, the yards, the home lanes and the tokens from the
`roll` and `move` messages, and prints the score and the event log beside them. Both
pages are served only when `NODE_ENV=development`.

## The public API

Every public read is zod-validated, cached for two seconds per URL and limited to
`PUBLIC_API_RATE_PER_MINUTE` (default 120) per address. `/api/config`,
`/api/matches/{live,upcoming,recent}`, `/api/matches/:id`, `/api/players/:id`,
`/api/leaderboard` and the tournament reads need no token; `/api/me/wallet`,
`/api/me/transactions` and `/api/me/bets` need a Supabase access token and are
never cached.

`docs/api.md` has every route, every stream message, an example of each, and the
Supabase Realtime tables the site should subscribe to. `src/api/contract.ts` is
the machine-readable half of the same contract.

## Graceful shutdown

On `SIGTERM` or `SIGINT`:

1. The process is marked as shutting down, so no new room is created and
   `/ready` starts returning 503.
2. The HTTP server stops accepting new connections, which also stops new
   WebSocket upgrades.
3. Running matches are given up to 30 seconds to finish (polled through
   matchmaking).
4. Colyseus (transport, presence, driver) is closed and the process exits with
   code 0 if every match finished, or 1 if the deadline forced the shutdown.

## Docker

```bash
docker build -t strikezone-server .
docker run --rm -p 2567:2567 --env-file .env strikezone-server
```

Multi-stage build on `node:20-slim`: dependencies and the TypeScript build happen
in separate stages, and the final image contains only `dist`, production
`node_modules` and `package.json`. It runs as the unprivileged `node` user and
ships a `HEALTHCHECK` that calls `/health` with `node`'s built-in `fetch`.

## Repository layout

```
src/
  app.ts            Express app (routes, CORS, 404, error handler)
  index.ts          HTTP server + Colyseus on one port, graceful shutdown wiring
  api/              HTTP routes: /health, /ready, /api/bots, /api/matches, /dev
  engines/carrom/   pure Carrom rules, and the bots
  engines/ludo/     pure Ludo rules
  rooms/            the referee and the Colyseus room
  tournaments/      brackets, rounds, progression, the scheduler and prizes
  odds/             odds model and simulator
  betting/          bets, markets, liability
  wallet/           wallet ledger (the only place money changes)
  admin/            admin operations
  lib/              env, logger, supabase, origins, lifecycle, shutdown, version,
                    fair-rng, canonical-json, match-log, match-repository,
                    match-store, match-verify
supabase/
  migrations/       numbered SQL migrations (applied by a human)
  tests/            local Postgres shim + SQL behaviour checks for the migrations
tests/                Vitest suites
```

### Money - wallet, betting and the operator's controls

This is the part of the system that must never be wrong twice. Everything below
follows one rule: **money moves only through `post_ledger_transaction`, and every
movement is keyed**, so a retry, a redelivered webhook or an operator double
click moves nothing new.

**Accounts.** Players have a wallet. `escrow` holds stakes at risk, `treasury` is
where the operator's cash enters, `withdrawal_hold` holds money owed to a player
while a withdrawal is being paid, and `house` is what the operator can lose. A
balance is never stored: it is the sum of append-only entries, and the ledger
refuses any transaction whose legs do not sum to zero or that would overdraw a
player.

**Placing a bet.** `POST /api/bets` validates the body, refuses a stake under
`MIN_STAKE_MINOR`, then calls `place_bet` (migration 009). That function does the
rest inside one database transaction, with the market and the house account
locked so two simultaneous bets cannot both pass a cap:

1. the idempotency key: a replay returns the original bet, a key belonging to
   someone else is a conflict;
2. the market must be `open` and the platform not paused;
3. odds drift: a price that fell is refused with the current price, a price that
   rose is taken, at the better price;
4. the stake floor, the market's own cap, the player's limits and the daily loss
   limit, self-exclusion, KYC in real money, and ten bets a minute;
5. the balance must cover the stake;
6. exposure: the match's exposure after this bet must stay inside
   `MATCH_EXPOSURE_PCT` of the free bankroll, and global exposure must stay inside
   the bankroll itself. A bet on the _other_ selection of a market can reduce
   exposure, because the stake is money the house keeps;
7. the stake moves into escrow, the bet is written, the payout is
   `floor(stake x odds)` computed on integers.

**Settlement.** The room publishes `markets.ready_to_settle`; `settleMatch`
verifies the match first (signature, hash chain, full replay) and refuses to
settle anything if verification fails, flagging the match instead. Then the
catalogue decides each market and the ledger moves the money:

| Outcome | Escrow        | Player    | House       |
| ------- | ------------- | --------- | ----------- |
| won     | `-stake`      | `+payout` | `-(profit)` |
| lost    | `-stake`      | -         | `+stake`    |
| void    | `-stake`      | `+stake`  | -           |
| hold    | nothing moves | -         | -           |

A payout above `LARGE_PAYOUT_MINOR` becomes `pending_review` with the money still
in escrow: approving pays it, rejecting refunds it. Whole-match voids are narrow
on purpose. A match abandoned before its first shot, or one where a human seat
never joined, voids everything. A forfeit settles the winner market and voids the
rest, because the match was not played as advertised. A bare dispute never voids
anything: the evidence decides, and the operator can suspend a market instead.

Settlement is idempotent: settled bets are no longer open, and every ledger
movement is keyed `settle:<betId>` (or `settle-void:<betId>` after a refusal), so
running it twice pays once.

**Payments.** A deposit is gated by self-exclusion and the daily deposit limit,
then handed to a provider. Three are wired: `mock` (virtual money, settles
instantly), `manual` (an operator confirms the transfer, the launch default for
real money) and a documented `paystack` stub that deliberately throws rather than
pretend to move money. A webhook is verified against the raw body, stored under
its provider event id, and then acted on once; an amount that does not match the
deposit is logged and refused. A withdrawal moves the free balance into
`withdrawal_hold` immediately. Approval moves nothing: only marking it paid
releases the hold to the treasury, so "approved" and "paid" can never be confused.

**The operator's view.** `GET /api/admin/solvency` returns player balances,
escrow, the hold, house and treasury funds, open exposure and the free bankroll.
`POST /api/admin/solvency/snapshot` stores the cash the operator says they hold
next to what players are owed and reports the gap, which is the number that says
whether the business is trading while insolvent. `GET /api/admin/reconcile`
returns the invariants: unbalanced transactions, accounts whose balance is not the
sum of their entries, negative player wallets, bets without a stake, and escrow
and the hold against what they should contain. Every one must be zero, and the
`money.sql` check fails the build if it is not.

**Verifying it.**

```bash
npm run money:demo             # the whole lifecycle, and the reports, in one run
supabase/tests/run.sh          # migrations, schema checks, 14 money checks
supabase/tests/concurrency.sh  # 100 simultaneous bets against the cap
npm test                       # 252 unit and route tests
```

`money:demo` is the DONE WHEN in one command: it tops up the bankroll through
`POST /api/admin/bankroll/topup`, places three bets through `POST /api/bets`,
settles the match, refuses the large payout that settlement held, and prints the
solvency and reconcile reports before and after. It runs against in-memory stores
so it needs no key and leaves nothing behind; the routes, rules, ledger and
settlement are the real ones, and the SQL is covered by the two harness scripts
above.

The concurrency check is the one worth reading: a hundred players bet at once on
a house with 1,000,000 kobo of free cash, and exactly the number of bets the cap
allows are accepted, with exposure stopping on the boundary rather than past it.

## Operations

Five things an operator does, and where each one lives.

### The operator API

Every route is behind `x-admin-key` (constant time over SHA-256 digests, ten wrong
keys from one address lock it out for fifteen minutes and raise a critical alert),
and every call writes an audit row with the path, status, actor and request id.

| Route                                                    | What it does                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/overview`                                | live matches, exposure per match and in total, free bankroll, pending reviews, flagged matches, active tournaments, open alerts, whether betting is paused |
| `GET /api/admin/health-deep`                             | database latency, live matches, the last reprice of each, scheduler leases, worker pool, open alerts                                                       |
| `GET /api/admin/audit-log`                               | the audit trail, filtered by action, target type, target id                                                                                                |
| `GET /api/admin/alerts`                                  | open alerts, newest first                                                                                                                                  |
| `GET /api/admin/bots`, `GET /api/admin/bots/:id/history` | the bots and their published numbers                                                                                                                       |
| `POST /api/admin/bots/:id/publish`                       | publish a bot's numbers; visible in its public history                                                                                                     |
| `POST /api/admin/markets/suspend`                        | suspend or resume one market of one match                                                                                                                  |
| `POST /api/admin/markets/override`                       | a market type's stake ceiling and margin                                                                                                                   |
| `POST /api/admin/users/:id/self-exclusion`               | set or lift a self-exclusion                                                                                                                               |
| `POST /api/admin/users/:id/kyc`                          | mark an identity check                                                                                                                                     |
| `POST /api/admin/users/:id/freeze`                       | freeze an account, or thaw it                                                                                                                              |
| `POST /api/admin/money/betting/pause`                    | stop every new bet, across restarts                                                                                                                        |

The money routes (top-up, solvency, reconcile, withdrawals, held payouts, pause)
are in `src/api/admin-money.ts` and the tournament controls in
`src/api/admin-tournaments.ts`.

### Security

- Helmet, with the cross-origin resource policy set to `same-site`.
- A global per-address rate limit (600/min by default) in front of every route,
  plus the tighter per-route limits the public reads already had.
- The CORS and WebSocket origin allowlists (`SITE_ORIGIN`), re-asserted after
  Colyseus installs its own listener.
- A body ceiling (`BODY_LIMIT_KB`) and per-message caps in both rooms: a message
  over `MAX_MESSAGE_BYTES` is refused, and a client sending more than
  `MAX_MESSAGES_PER_SECOND` is disconnected after five refusals in a minute.
- A UUID request id on every response, in every log line and in the error body.
- A production start that refuses `ADMIN_API_KEY` under 32 characters or a
  missing `RESULT_SIGNING_SECRET`.
- `npm run audit` fails on a high-severity advisory in a production dependency.

### Monitoring

`alerts` rows are written **before** the webhook is posted, so a lost POST never
loses the alert. Three conditions raise one today: the free bankroll below
`ALERT_FREE_BANKROLL_MINOR` (critical), a settlement that failed (critical, with
the failing check), and an admin lockout (critical, with the address). Sentry is
loaded through a dynamic import: without `SENTRY_DSN` or without the package
installed, nothing is sent and nothing fails.

### Deploying

One instance, always warm, because the matchmaker's room list, the lockout
counters and the worker pool live in the process. `railway.json`, `fly.toml` and
`render.yaml` all describe that single instance; `docs/DEPLOY.md` has the
migrations, the secrets to generate, the post-deploy checks and the ops runbook.

### Load testing

`npm run loadtest -- --url http://localhost:2567 --seconds 20 --concurrency 50`
reports throughput and p50/p95/p99 over the real public reads, plus games a second
through the simulator. `docs/LOAD_TEST.md` has the budgets and how to read the
output.

## Task log

### Scaffold - project skeleton, config, health and readiness

Added:

- Toolchain: `package.json` (TypeScript strict, ESM, Node 22+), `tsconfig.json`
  for type-checking, `tsconfig.build.json` for emitting `dist`, ESLint flat
  config (also enforces the `AI_RULES.md` bans on default exports, `Math.random`
  and `any`), Prettier, and Vitest.
- `src/lib/env.ts`: zod-validated, typed, frozen `env` object covering
  `PORT`, `NODE_ENV`, `SITE_ORIGIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `RESULT_SIGNING_SECRET`, `ADMIN_API_KEY`, `MONEY_MODE`, `CURRENCY` (default
  `NGN`) and `HOUSE_MARGIN_BPS` (default `600`). A missing or invalid variable
  stops the process with a message naming that variable and no secret values.
- `src/lib/logger.ts` (pino with key-based redaction), `src/lib/supabase.ts`
  (single service-role client plus a connection probe), `src/lib/origins.ts`
  (CORS + WebSocket allowlist), `src/lib/lifecycle.ts`, `src/lib/shutdown.ts`,
  `src/lib/version.ts`.
- `src/app.ts` with `GET /health` and `GET /ready`; `GET /health` returns
  `{ ok: true, version, uptimeSeconds }`.
- `src/index.ts` serving Express and Colyseus from one `http.Server` on `PORT`,
  with the WebSocket origin check and SIGTERM/SIGINT handling (30 second drain).
- Empty module folders from `AI_RULES.md`, each with a `README.md` describing its
  purpose and the rules that apply to it.
- `Dockerfile` (multi-stage, `node:20-slim`, non-root, `/health` healthcheck),
  `.env.example`, `.gitignore`, `.dockerignore`.
- `tests/health.test.ts`: one Vitest test for `/health`.

How to test it:

```bash
npm install
npm test                      # one suite, /health returns ok: true
npm run lint                  # no errors
npm run typecheck             # strict, no errors
npm run build && npm start    # or: npm run dev
curl -s localhost:2567/health # {"ok":true,"version":"0.1.0","uptimeSeconds":3}
curl -s -o /dev/null -w '%{http_code}\n' localhost:2567/ready   # 200 with a valid Supabase config, 503 otherwise
PORT= node dist/index.js      # prints that PORT is missing and exits 1
```

### Database schema - migrations 001 to 007

Added the full baseline schema as seven ordered SQL files in
`supabase/migrations`, plus `supabase/README.md` with the run order, a summary of
each file, the conventions and the decisions that need your review.

- `001` profiles and players, with `players.is_bot` generated from `kind` so a
  bot can never be presented as a human.
- `002` wallet accounts and the append-only ledger: `post_ledger_transaction()`
  writes a transaction and its legs atomically, requires the legs to sum to
  exactly zero, refuses to overdraw a user account, refuses unknown accounts and
  unknown entry fields, and returns the original row when the idempotency key has
  been used. Triggers reject `UPDATE` and `DELETE` on the transaction and entry
  tables. `account_balances` derives balances instead of storing them.
- `003` matches, seats and the hash-chained, append-only `match_events` log.
- `004` tournaments, entries, the bracket, and the `matches.tournament_id`
  foreign key that file 3 could not declare yet.
- `005` markets and bets, the `updated_at` trigger, and the `open_liability` and
  `house_bankroll` views.
- `006` row level security on every table, read policies (own data for profiles,
  wallets, ledger entries and bets; public reads for players, matches,
  tournaments, markets and finished-match events), revoked browser writes, and
  the realtime publication.
- `007` the house account, the escrow account and six labelled bots.

All money columns are `bigint` in the smallest unit; there is no floating point
money column anywhere. Every table, view, function and most columns carry a
comment. Every file runs in a transaction and creates its objects conditionally.

How to test it: `supabase/tests/run.sh` builds a scratch database, applies a
stand-in for Supabase's `auth` schema, roles and realtime publication, runs all
seven migrations in order, then runs `supabase/tests/verify.sql`, which asserts
23 behaviours (ledger arithmetic, refusal cases, idempotency, append-only
triggers, both views, row level security for a user and for an anonymous
visitor, the publication contents and comment coverage) and prints `PASS` for
each:

```bash
./supabase/tests/run.sh          # needs a local Postgres with create-database rights
```

Verified against PostgreSQL 15.19: all seven files apply cleanly, re-running all
seven is a no-op with no duplicate seed rows, and all 23 checks pass.

Nothing in this schema is wired into the server yet: `src/wallet`, `src/betting`
and the rooms still need their code, and `post_ledger_transaction()` is the
function they will call.

### Carrom engine

Built the carrom engine in `src/engines/carrom`, after reading
`samiranrl/Carrom_rl` for its rules, board conventions, coin and striker setup and
shot interface. That project is GPL v3, so nothing was copied, translated or
paraphrased: every file carries a header naming the reference and stating the
code is original. What I learned, the rules implemented, the fifteen decisions and
the twelve open questions are written up in `docs/carrom-rules.md`.

- `config.ts` holds every tunable in one place: 740 mm board, 45 mm pockets,
  31 mm coins, 41 mm striker, 5 g and 15 g, wall restitution 0.6, coin
  restitution 0.9, rolling friction 1600 mm/s², 1/240 s step, match limits.
- `physics.ts` is custom circle physics, no third-party engine: fixed timestep,
  rolling friction down to a stop threshold, wall bounces, pairwise impulses with
  positional correction, pocket capture on the centre entering the pocket zone,
  and a repeated pass so many bodies in the same step resolve without overlapping.
  It is deterministic by construction and the tests assert it.
- `rules.ts` is the ICF-style singles rules, pure and independent of physics:
  turns, the queen (take after an own coin, cover on the same turn, return when
  uncovered), fouls for the striker or an opponent's coin with a penalty coin or a
  recorded debt, board scoring at 1 per opposing coin plus 3 for a covered queen,
  and the 25-point or 8-board match.
- `index.ts` is the public API: `createInitialState`, `getLegalStrikerRange`,
  `applyShot` returning `{ state, events, frames }`, plus `BotPolicy` for bots
  that do not exist yet. Shots are validated with zod, including rejection of
  unknown fields. Frames are opt-in so the odds simulator can run without them.
- `src/lib/fair-rng.ts` is the seeded generator AI_RULES.md requires: an
  independent sfc32 implementation seeded from SHA-256, with seed commit and
  verify helpers for the provably fair flow.

How to test it:

```bash
npm test                  # 51 tests, including 50 for the engine and the rng
npm run carrom:demo       # plays a whole board with random legal shots
npm run carrom:demo -- --seed my-seed --max-shots 400
```

The suite covers determinism (same input twice, and a twelve-shot sequence
replayed), the invariants after every shot of a board (no overlap, nothing off the
board), a straight shot that pockets a coin next to a pocket, every rule above
including queen cover and return, both fouls, penalty debt and board scoring,
config validation and striker placement (including a blocked baseline), and
performance: a twenty-shot board without frames takes about 7 ms here, printed by
the test, which fails above 20 ms. The demo plays a board to an end and, with the
default seed, a whole match.

No bots, rooms or betting wiring yet: `applyShot` is what a room will call, and
`BotPolicy` is the seam a bot plugs into.

### Ludo - the second game

Ludo is the second game, and it is the proof that the seams hold: the engine, the
room, the verifier and the viewer all attach to the same interfaces Carrom uses,
and nothing in the tournament, money or API layers was rewritten to admit it.

**The engine** (`src/engines/ludo/`) is a pure state machine over a typed board:
four seats, four tokens each, a six-sided die, twelve ring cells between starts,
a five-cell home lane and a one-cell home. Rolls come from a seeded stream, never
from `Math.random`, so a match is a seed plus the sequence of choices. The referee
(`src/rooms/ludo-match-runner.ts`) owns those choices: a human has exactly one
message type, `{ type: "move", tokenIndex }`, twenty seconds to send it, and the
published policy plays for them if they do not (three timeouts forfeit the match).
Bots think for one to three seconds, so a game reads like four people playing.

`src/engines/ludo/sim.ts` is the same rules, alloc-free, for the simulator: over a
million turns a second, used by the bench and by anything that wants to sample
games without a room.

**Verification** is the same promise as Carrom, answered for a die: the revealed
seed hashes to its commitment, the log's hash chain runs to the head the result was
signed over, every recorded roll is the roll the seeded stream produced, every
recorded move is legal from the position the log rebuilds, and the finishing order
the replay reaches is the one in the signed result. `npm run verify-match -- <id>`
dispatches on the match's game, so one command verifies either.

```
npm run ludo:demo
```

plays a whole four bot match in memory, verifies it, prints `PASS`, then rewrites a
recorded roll and shows the verifier refusing it: the failure is reported as a roll
the seed did not produce, not merely as a broken hash, because the tampered entry is
re-chained before it is offered.

**Tournament heats are not wired yet.** The bracket seam is two-seat by
construction: `tournament_matches` has `seat1_player_id` and `seat2_player_id`,
`PositionSeat` is `1 | 2`, and the scheduler advances a winner into one seat of one
later position. A four-seat heat needs a place for four entrants, a finishing order
and an advancement rule that takes the top two, which is a schema change before it is
a code change. `supabase/migrations/010_ludo_heats.sql` is written and verified
against a scratch Postgres, and is **not yet applied** to the live project: it adds
`tournament_match_entrants`, `format_seats`, `finishing_order` and
`advance_per_heat`, and mirrors every existing position into the new table. Ludo
tournaments run the two-seat formats until it is applied and the format lands. See
`docs/ludo-tournaments.md`.

**What to watch out for.** The browser client takes the _origin_ as its endpoint
(`new Client("ws://host")`), not the socket path: the SDK appends `matchmake/...` to
whatever path it is given and the matchmaker is mounted at the root, so
`ws://host/colyseus` answers 404 to every join. Both dev pages had that bug and both
are fixed; the room's socket URL comes back in the seat reservation anyway.

A bot that waited a second on every forced move made a four bot game take four
minutes, so the single-legal-move delay applies only to a human. And the log's turn entries are appended as they happen, chained one at a
time: a result entry written by the same `await` chain cannot race them, which is
what makes the replay trustworthy in the first place.

### Live matches - bots, the referee and the log

A match can now be played end to end between two bots and then verified by a
stranger from the database alone. This section is the documentation for that: what
each piece is, why it is built that way, and how to run it.

#### Provably fair randomness

`src/lib/fair-rng.ts` is the only source of game randomness in the repository
(`AI_RULES.md` hard rule 3; the ESLint config rejects `Math.random` in `src/`).

- `createMatchSeed()` makes 32 random bytes with `randomBytes`, and is the only
  place a seed is created.
- `commitOf(seed)` is the SHA-256 of the seed. It is published before the first
  shot, so the server is locked in before anyone plays.
- A match never draws from a PRNG stream. Every number is
  `rngAt(seed, matchId, nonce)`: an HMAC-SHA256 of the seed keyed per match, with
  a counter for the nonce. Anyone holding the revealed seed can re-derive every
  draw in order, and no draw depends on how many numbers were drawn before it.
- `gaussian(rng)` turns uniform draws into normal ones (Box-Muller), which is what
  bot aim error needs; `verifyCommit` checks the revealed seed against the
  commitment in constant time.

`MatchRng` wraps that stream and counts the draws, so a result can record how much
randomness the match consumed. `createSeededRng` (sfc32, SHA-256 seeded) remains
for places that only need reproducibility rather than provable fairness: the
engine's own tests and the demo.

`src/lib/canonical-json.ts` exists for the same reason: a hash is only meaningful
if both sides serialise identically, so keys are sorted, `undefined` is dropped
and floats are written with a fixed rule. The log and the signature both use it.

How to test it: `npm test -- tests/lib`. The suite covers determinism, the
commitment round trip (including a wrong seed), that no two nonces repeat, and a
chi-square check of 100,000 draws against uniformity (18.47 against a critical
value of 43.82 here).

Next: bots, so there is something to play against.

#### Bots

Three levels, published through `GET /api/bots` and defined once in
`src/engines/carrom/bot-config.ts`, so the numbers a player is shown are the
numbers the bot actually plays with:

| Level    | Display name | Aim error (degrees) | Power control | Candidate selection |
| -------- | ------------ | ------------------- | ------------- | ------------------- |
| `rookie` | Bot Rookie   | 4.0                 | 0.40          | 0.45                |
| `club`   | Bot Club     | 2.0                 | 0.70          | 0.80                |
| `master` | Bot Master   | 0.8                 | 0.95          | 0.98                |

A bot is never a fake person: it is a `players` row with `kind = 'bot'`,
`bot_policy` set and no `profile_id`, it is seated as `isBot: true` in the room
state, and the catalogue says so too.

How a bot picks a shot (`src/engines/carrom/bots.ts`):

1. **Ghost-ball candidates.** For every coin of its own colour and both pockets it
   computes the contact position behind the coin (a straight pot), and adds one
   one-cushion bank per pocket, mirroring the pocket through the simplest wall.
   Candidates whose striker placement would sit off the baseline or be blocked are
   dropped, and cut angles above ~80 degrees are refused as unrealistic.
2. **Scoring.** Each candidate is scored by cut angle, by the distance the coin has
   to travel and by whether anything sits on the coin's line to the pocket. The
   queen is worth taking when it is the bot's to take.
3. **Selection.** Candidates are chosen by softmax over their scores with
   `selectionQuality` as the temperature, so a stronger bot almost always takes
   the best shot it found and a weaker one sometimes takes the second best.
4. **Execution error.** The chosen angle gets gaussian noise scaled by
   `aimErrorDegrees`, and the power gets gaussian noise scaled by
   `1 - powerControl`. Both come from the match RNG, so a bot shot is reproducible
   from the seed like any other.

The fallback is `safeShot()`: a gentle straight shot to the baseline used for a
timeout, so a slow player never stalls the match.

How to test it: `npm test -- tests/carrom/bots.test.ts`. It checks that every
published number is in range, that a bot never proposes an illegal shot over a
few hundred positions, that a straight pot in front of a pocket is found, that a
weaker bot misses more often than a stronger one over many seeds, and that the
same seed and state produce the same shot.

Next: recording a match so the result can be checked afterwards.

#### The match log, storage and verification

A finished match can be checked by anyone holding the database, which is the
point: the server says a match ended 25-3, and the claim can be tested rather than
trusted.

**The log** (`src/lib/match-log.ts`) is append-only and hash-chained:

```
hash(n) = SHA-256( hash(n-1) + canonicalJson({ seq: n, type, payload }) )
hash(0) = the seed commitment
```

Every shot, every rule event, every timeout and every forfeit is a row, written by
the referee and by nothing else. `prev_hash` links each row to the one before it,
so editing a power value, dropping a row or reordering two rows breaks every later
hash. `verifyLogChain` walks the chain, checks the sequence numbers are contiguous
from 1, checks each link, and checks the first link is the commitment.

`signResult` is an HMAC-SHA256, keyed with `RESULT_SIGNING_SECRET`, over the
canonical result plus the _head_ of the chain. Signing the head as well as the
result binds the outcome to the log: a different log produces a different
signature. The log is sealed before the signature is taken, so the closing
`match_end` row is covered too.

**Storage** (`src/lib/match-repository.ts`) is one interface with two
implementations: `SupabaseMatchRepository` over the tables from migrations 003,
and `InMemoryMatchRepository`, which enforces the same rules (append-only,
contiguous sequence numbers, no going back from `finished`) so the whole of live
play can be tested with no database and no network. `src/lib/match-store.ts` holds
the single store the process uses and resolves it lazily, so importing it never
builds a client and tests can swap in the in-memory one.

**Verification** (`src/lib/match-verify.ts`, and `npm run verify-match -- <id>`)
reports the first failure with the log sequence number where it happened:

1. the match is finished and has a revealed seed;
2. the revealed seed hashes to the commitment published before play;
3. the chain is intact from that commitment to its head, and the head stored on
   the match is that head;
4. every recorded shot, replayed through the engine from the seed, produces
   exactly the events the log recorded for it;
5. the replay's final score and shot count match the signed result;
6. the result signature verifies.

Nothing in there trusts the room: it uses the stored log, the stored result and
the engine, and nothing else.

How to test it: `npm test -- tests/lib` and `tests/rooms/carrom-match-runner.test.ts`.
The tests prove the happy path and that tampering is caught: an edited shot
payload, a dropped row, and a result that disagrees with the replayed board are
each rejected, with the failing sequence number reported.

Next: the referee that produces all of this.

#### The referee and the room

`src/rooms/carrom-match-runner.ts` is the referee. One runner owns one live match:
the rules, the clock, the bots, the timeouts, the forfeits and the log. It knows
nothing about WebSockets, which is why a whole match can be played and verified in
a test with no server and no socket.

Only the runner decides. A client sends one shot; turn order, legal placement,
scoring, penalties, timeouts and forfeits are all decided here, by calling the same
engine functions the tests use. A shot is refused, with a reason, when the match is
not live, when it is not that seat's turn, when the message names a move that has
already happened (`expectedShot`), when the engine rejects the placement or the
power, or when the previous shot is still being resolved. Everything that changes
state goes through one queue, so two messages can never interleave halfway through
a shot.

The clock: a human has 30 seconds (`turnSeconds`). Running out plays a safe shot
for them and counts a timeout; the third timeout forfeits the match. A
disconnected player has 60 seconds to come back before the same forfeit applies.
Bots are not on the clock: they pause 1-3 seconds before shooting so the match
reads like a game rather than a batch job.

`src/rooms/carrom-room.ts` is the transport shell: it authenticates joins, validates
every message with zod, mirrors the referee's snapshot into Colyseus state and
forwards what the referee emits. It never decides a rule itself.

- **Joining.** A seated human joins with a Supabase access token, checked with
  `supabase.auth.getUser`, and the user must hold a seat in that match, otherwise
  the join is refused. A spectator joins with `{ spectate: true }` and may be
  anonymous; spectators receive every shot and may send nothing at all.
- **Starting.** Only the server creates a room, and it hands the room the seed. A
  client that tried to start a match itself would have to supply a seed that hashes
  to the commitment already published for the match, which it cannot do.
- **Messages.** `{ type: "shot", shot: { strikerPosition, angle, power }, expectedShot? }`,
  validated with `z.strictObject` so unknown fields are rejected, including an
  attempt to smuggle extra keys. A refused shot comes back as
  `{ code, message }` with one of `not_live`, `match_over`, `not_your_turn`,
  `stale_shot`, `illegal_shot`, `invalid_message`, `spectator`, `busy`.
- **State.** The room state carries scores, board, coins, whose turn it is, the
  turn deadline, each seat's timeout count and `isBot`, and the seed commitment.
  The seed itself is never in the state, never in a message and never in a log
  payload; it is revealed only when the match finishes.
- **Lifecycle.** A room outlives its clients on purpose: a dropped player has a
  reconnection window, and a failed join must not be able to dispose the room for
  everyone else, so `autoDispose` is off and the room closes ten seconds after the
  result.

The room state is declared with `@colyseus/schema` 5's `schema()` builder rather
than decorators, which keeps the project's plain TypeScript settings.

How to test it: `npm test -- tests/rooms`. `carrom-match-runner.test.ts` plays a
full Master vs Club match in-process (313 shots, 7 boards, 247 ms) and verifies it,
then checks every refusal path and the tamper detection. `carrom-room.test.ts`
boots a real Colyseus server and joins it with real clients: a bot match is
spectated to its end and verified, a spectator is refused a shot, a seated player
shoots on their turn and not out of turn, an illegal power and a stale move are
refused, and an unseated token is refused without disturbing the player who is in.

Next: endpoints and scripts, so this can be driven from outside.

#### Endpoints and scripts

`GET /api/bots` publishes the catalogue described above, straight from
`bot-config.ts`.

`GET /api/matches/:id/replay` is the public record: the seats, every log row, and
`verification` (whether the chain is intact and where its head is). `seedReveal` is
null while the match is live and filled in once it has finished. Anyone can poll
it, so a player can check that the commitment they were shown before the match is
the one the seed hashes to afterwards.

`POST /dev/start-match` exists so the whole pipeline can be exercised locally
without two browsers. It is mounted **only** while `NODE_ENV=development`; in test
and production the route does not exist at all. Body (all optional, all validated
with zod, unknown fields rejected): `{ white: { bot }, black: { bot }, turnSeconds,
allowSpectators }`. It creates the match, commits to a fresh seed, creates the room
with that seed, and returns `{ matchId, roomId, seedCommit, seats }` plus the two
commands below.

```bash
npm run dev
curl -s -X POST localhost:2567/dev/start-match -H 'content-type: application/json' -d '{}'
# -> { "matchId": "...", "roomId": "...", "seedCommit": "...", ... }
npm run carrom:watch -- <roomId>      # follow the shots in the terminal
npm run verify-match -- <matchId>     # check the finished match
```

`npm run carrom:watch` is a spectator client: it joins anonymously, prints the
state and every shot, and leaves when the match ends. It is also the quickest way
to see that a client needs no seat to follow a match and can do nothing else.
Colyseus's own monitor is mounted at `/colyseus` in development for the same
purpose.

`npm run verify-match` works from the database alone and prints:

```
ok   match_finished
ok   seed_commit
ok   hash_chain
ok   shot_replay
ok   final_result
ok   result_signature
PASS 5f0c...: 313 shots replayed, chain, result and signature intact
```

or stops at the first failure with the event it happened at, for example
`FAIL <id>: the replay ends 21-6 but the result says 26-3`, and exits 1.

Next: what was decided along the way, and what to watch out for.

#### Decisions, and what to watch out for

1. **The seed never touches a client-visible row before the reveal.** The match row
   holds the commitment; the seed lives in the process that runs the room and is
   written to `seed_reveal` only when the match finishes. The room therefore has to
   be handed the seed at creation, which is server-only, and it re-checks
   `commitOf(seed) === seed_commit` before starting. That check is what closes the
   hole: a client that tried to create the room itself could only supply a seed
   that fails it, so it cannot choose the RNG stream.
2. **The signature covers the log head, not just the result.** Signing the result
   alone would let the log be rewritten while the signature still verified. The log
   is sealed first (`match_end` written) and then the head is signed, so the
   closing row is inside the signature too.
3. **The in-memory store enforces the database's rules.** Append-only events,
   contiguous sequence numbers, no transitions out of `finished`. Without that the
   offline tests would prove less than they look like they prove.
4. **`@colyseus/schema` 5 dropped `defineTypes`.** It is deprecated and, called by
   hand, it no longer wires up the metadata the encoder needs (`Cannot read
properties of undefined (reading 'Symbol(Symbol.metadata)')`). The room state uses
   the `schema()` builder with `t.*` fields instead, which also means the project
   needs no decorator compiler settings.
5. **A consented leave is close code 4000.** Colyseus's `CloseCode.CONSENTED` is
   4000, not the WebSocket `1000`. Treating 1000 as "left on purpose" sent every
   deliberate leave down the reconnection path and held the room for the full
   window. Anything that is not 4000 is treated as a drop.
6. **Rooms do not auto-dispose.** A room that disposes when it has no clients can be
   taken down by a single failed join attempt, which is a denial of service for the
   player who is in it. `autoDispose` is off; the room closes ten seconds after the
   result, or when the process drains.
7. **`onCreate` must be awaited.** Returning before the async setup finished let a
   client join and be refused as "not seated" because the match had not been loaded
   yet. Colyseus awaits `onCreate`, so the setup is awaited inside it.
8. **One queue, one state change at a time.** Early on, two bot loops could run
   concurrently around an `await` and apply shots against stale state, which showed
   up as missing log sequence numbers and a replay that disagreed with the result.
   Every state-changing path now goes through one queue, and the bot loop has an
   activity flag.
9. **Bots needed a banker to finish a board.** With straight pots only, a board
   could stall for hundreds of shots once the coins that were easy to pot were gone;
   matches reached the board limit instead of a score. Adding one-cushion bank
   candidates took a Master vs Club match to 289-387 shots over 7-8 boards, which is
   why the board shot limit (400) is a safety net rather than a normal ending.
10. **Timeouts are per seat, and the safe shot keeps play moving.** A timeout plays
    `safeShot()` rather than passing the turn, so a match between two idle humans
    still terminates: each seat's third timeout forfeits it. The timeout count is in
    the room state so a client can show it.
11. **Spectators are anonymous and inert.** They receive every broadcast and every
    state patch, and a shot from one is refused with `code: "spectator"`. Cap 20 per
    room; `maxClients` is two seats plus that cap.

What the tests cover, in numbers: 104 Vitest tests across 15 files. The ones that
matter most here are the in-process match (a full Master vs Club match, verified),
the real-WebSocket room tests, and the tamper cases (edited payload, dropped row,
result that disagrees with the replayed board) which must all fail with the event
that gave them away.

### Tournaments - brackets, money and a job runner

`src/tournaments` runs a tournament from the admin's first click to the champion's
prize. The design is in `src/tournaments/README.md`; the short version:

- **Two formats behind one seam.** Single elimination (2 to 64 players, byes to
  the best seeds) and round robin (3 to 8, every pair once, circle method). A
  format answers three questions - what the schedule is, where a winner goes, and
  who finished where - and nothing else in the codebase asks which one is running.
  The game is a field on the config, not a branch in the logic: the only game-aware
  code is the launcher that maps a game name to a room name.
- **The lifecycle lives in the database.** draft, registration, running, finished,
  cancelled, with entries, bracket positions, matches and money all as rows. A
  restart is a tick: `resume()` asks what is due and does it, which is exactly what
  a ten-second tick does.
- **Money is three ledger transactions.** The entry fee in, the refund out, and one
  balanced transaction at the end carrying the rake, the prizes and the house's
  share. Every one is keyed, so repeating a call returns the first transaction
  rather than paying twice.
- **Races are settled by conditional writes.** Two servers cannot both start a
  tournament, launch a match or decide a bracket position, and the test that
  proves it gives the scheduler a lease that always says yes.
- **Walkovers.** A human who has not connected three minutes after the match was
  due loses it to the player who is there.

A bot's prize never pays a bot: it passes to the best-placed human below, or stays
with the house, per `botPrizePolicy`.

To see a whole tournament play itself out against a running server (bot entries
pay no fee, so no money is created):

```
npm run dev                                   # in one terminal
npm run tournament:demo -- --players 8        # in another
```

It creates the tournament through the admin API, lets the scheduler fill and play
it, prints the champion, the prize split and every bracket result, and finishes by
listing the `npm run verify-match -- <id>` commands that re-check each match from
the database alone.

What the tests cover, in numbers: 43 Vitest tests across 5 files for the
tournament work alone (brackets for every entrant count, the two formats'
finishing orders, the prize split and its balance invariant, the full lifecycle,
walkovers, cancellation refunds, restart recovery, the scheduler's lease and a
lying lease), plus 155 across the repository.

### Money - wallet, betting and the operator's controls

Migration `009_money_extras.sql` adds the treasury and withdrawal-hold accounts,
`pending_review` bets, the deposit, withdrawal, limit, flag, snapshot and audit
tables, and `place_bet`, which places a bet in one transaction with the market and
the house locked. `solvency_report` and `reconcile_report` expose the position and
the invariants as one object each.

`src/betting` holds the rules (payout on integers, odds drift, the two void rules,
held payouts), the bets repository, placement and settlement. `src/wallet` holds
the providers, deposits and withdrawals. `src/admin` holds the bankroll, solvency,
reconcile and payout review, all audited.

Two defects were found and fixed while testing. A limit that was being _created_
was treated as a relaxation, so a new limit waited twenty-four hours before it
applied; setting a limit is now a tightening. And `BetWithMarket` carried both the
bet id and the market id under the name `id`, so settlement updated the wrong row;
the market's id is now `marketRowId`.

Verified with 14 SQL checks (including solvency and reconcile reporting zero
differences), a 100-way concurrency storm that accepts exactly the bets the cap
allows, and 252 unit and route tests.

### The money demo - the DONE WHEN, in one command

`npm run money:demo` runs the whole lifecycle in one process: top up the bankroll
through the admin route, place three bets through `POST /api/bets`, settle the
match, refuse the large payout that settlement held back, and print the solvency
and reconcile reports before and after. It ends with the book balancing: every
account matches its entries, escrow holds exactly the open stakes, nothing is
negative, and both reconcile runs report zero differences.

The demo uses in-memory stores so it needs no keys and leaves no rows behind. The
launcher sets throwaway environment values first, because `src/lib/env.ts`
validates at import time and refuses to start without them.

Two seams are documented in the file rather than hidden: placement mints the bet
row (in SQL, `place_bet` escrows the stake inside its own transaction, so the demo
moves it itself) and settlement takes its verification and stats as fixed answers
(the real verifier is covered by the settlement tests).
