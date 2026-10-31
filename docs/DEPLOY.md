# Deploying strikezone-server

One process, one instance, always warm. Everything below follows from that.

The server holds three things in memory that a second instance would not share:
the Colyseus matchmaker's room list, the admin gate's lockout counters, and the
pricing worker pool. A join request routed to a process that has never heard of
the room answers `not_found`; a live price computed on the wrong process writes
prices from a board it is not watching. The scheduler is the exception: it takes
a lease in `scheduler_leases`, so two instances would not double-run it, but
everything else in that list still applies. Scale the machine, not the count.

## Before the first deploy

1. **Apply the migrations, in order**, in the Supabase SQL editor or with
   `psql "$SUPABASE_URL" -f` per file: `001` through `011`. They are written to
   be re-runnable (`create table if not exists`, `add column if not exists`), but
   the order matters: `009` alters tables `002` and `005` created, and `011`
   alters `profiles` from `001`.
2. **Generate two secrets and keep them out of the repository**:
   - `RESULT_SIGNING_SECRET`: 32 bytes of randomness (`openssl rand -hex 32`). It
     signs every match result; changing it invalidates the signature of every
     match signed with the old one, though already-settled matches keep their
     payouts.
   - `ADMIN_API_KEY`: 32 characters or longer. The server refuses to start in
     production with anything shorter.

   Generation, storage and rotation are covered in [The two secrets](#the-two-secrets).

3. **Set the environment** from `.env.example`. The server validates it at start
   and exits with the list of what is wrong, so a bad deploy fails at boot rather
   than at the first bet.

Required in production: `NODE_ENV`, `PORT`, `SITE_ORIGIN`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESULT_SIGNING_SECRET`,
`ADMIN_API_KEY`. Everything else has a defensible default.

## The health endpoints

| Path                     | Who calls it                     | What it answers                                                                                    |
| ------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/health`                | the platform's healthcheck       | the process is up                                                                                  |
| `/api/admin/health-deep` | your monitor, with `x-admin-key` | database latency, live matches, last reprice per match, scheduler leases, worker pool, open alerts |

A platform healthcheck that poked the database would restart the service for a
database blip; that is why `/health` is shallow and the deep check is separate
and authenticated.

## Railway

`railway.json` builds the `Dockerfile` and healthchecks `/health`.

```bash
railway login
railway init
railway up
railway variables set NODE_ENV=production SITE_ORIGIN=https://example.com
railway variables set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
railway variables set RESULT_SIGNING_SECRET=... ADMIN_API_KEY=...
railway domain
```

Set the replica count to 1. Railway's proxy terminates TLS and forwards
WebSocket upgrades; Colyseus needs nothing extra, but the idle timeout must be
longer than the match's own heartbeat, so leave the default and confirm a room
stays connected through a full game.

## Fly.io

`fly.toml` is written for one always-on machine in `jnb` with a 1 GB / 2 vCPU
VM, `auto_stop_machines = false` and a `/health` check every 15 seconds.

```bash
fly launch --no-deploy --copy-config
fly secrets set SITE_ORIGIN=https://example.com \
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  RESULT_SIGNING_SECRET=... ADMIN_API_KEY=...
fly deploy
fly scale count 1
```

`auto_stop_machines` must stay `false`: a match is a live process, and a machine
that stops on idle kills every room on it and abandons the bets on those matches.
If a machine is upgraded, wait for the matches in flight to finish: the shutdown
path drains rooms and closes the pool, and the platform's kill timeout is 30
seconds, which is what the stop signal is given.

## Render

`render.yaml` describes the same service: Docker runtime, one instance,
`/health` check, secrets marked `sync: false` and entered in the dashboard.

Do not use a plan that spins down on idle. A slept process is a lost room and an
unsettled match; the `starter` plan in the file is the smallest that stays warm.

## The two secrets

Two values are secrets in the strict sense: losing control of either one is an
incident. Everything else in `.env.example` is configuration.

| Name                    | What it protects                                                     | If it changes                                         |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `RESULT_SIGNING_SECRET` | the signature on every match result, which is what settlement trusts | results signed with the old value no longer verify    |
| `ADMIN_API_KEY`         | every `/api/admin/*` route, including money movements                | the old key stops working, and lockout counters reset |

`SUPABASE_SERVICE_ROLE_KEY` is the third value that must never leak: it bypasses
row level security on every table. It is a Supabase secret, not one this server
mints, and it is rotated in the Supabase dashboard.

### Generate

```bash
openssl rand -hex 32   # RESULT_SIGNING_SECRET, 64 characters
openssl rand -hex 32   # ADMIN_API_KEY, 64 characters
```

Both go in the host's environment, never in the repository. `.env` and `.env.*`
are ignored by git and only `.env.example` is tracked; the placeholders in it are
not secrets. To confirm nothing has leaked:

```bash
git ls-files | xargs grep -l "$RESULT_SIGNING_SECRET" 2>/dev/null   # expect no output
git ls-files | xargs grep -l "$ADMIN_API_KEY" 2>/dev/null           # expect no output
```

### Store, per host

```bash
# Railway
railway variables set RESULT_SIGNING_SECRET=... ADMIN_API_KEY=...

# Fly.io
fly secrets set RESULT_SIGNING_SECRET=... ADMIN_API_KEY=...
```

Render has no settled CLI for environment variables: use **Dashboard → your
service → Environment → Add Environment Variable**, one row per name, and save.
The service redeploys with the new values.

`render.yaml` marks both as `sync: false`, which means "entered by hand in the
dashboard and never written to the file". Keep it that way.

### The guard that enforces this

Production will not start without them, and the refusal names the problem rather
than failing later at the first bet:

```console
$ NODE_ENV=production ADMIN_API_KEY=tooshort-to-pass-the-guard npm start
[strikezone-server] refusing to start.
Environment configuration is invalid:
  - ADMIN_API_KEY must be at least 32 characters in production

$ NODE_ENV=production RESULT_SIGNING_SECRET= npm start
[strikezone-server] refusing to start.
Environment configuration is invalid:
  - RESULT_SIGNING_SECRET is missing
```

Verified against this repository on 2026-10-31, along with a production boot on a
generated pair answering `/health` in under two seconds.

### Rotate

Rotate `ADMIN_API_KEY` whenever a person who knew it leaves, or on a schedule:

1. Set the new value in the host's environment. The platform restarts the service.
2. `curl -H "x-admin-key: $NEW_KEY" https://your-host/api/admin/health-deep`
   answers 200. The old key now answers 403, and the lockout counters start clean.
3. Hand the new key to whoever needs the console, through a password manager. It
   does not belong in a chat message or a commit.

Rotate `RESULT_SIGNING_SECRET` only when it may have leaked, because it
invalidates signatures rather than just access:

1. Pick a moment with no match sitting between "finished" and "settled". A match
   signed with the old secret and settled after the change fails verification, is
   refused, and raises an alert rather than paying out on a result it cannot
   check. That failure mode is deliberate, but it is a support ticket.
2. Set the new value and let the service restart.
3. Play one fresh match end to end against production
   (`npm run money:demo:live`) and confirm `PASS` with a reconcile of zero. That
   proves the new secret is in use and the whole settle path still works.
4. Record the rotation somewhere with a date. An unrecorded rotation is
   indistinguishable from a leak the next time somebody reads the logs.

Settled matches keep their payouts: the ledger does not depend on the signature,
only the decision to settle did.

## After the deploy

1. `curl https://your-host/health` answers 200.
2. `curl -H "x-admin-key: $ADMIN_API_KEY" https://your-host/api/admin/health-deep`
   answers with `database.ok: true` and a latency in single-digit milliseconds.
3. `curl https://your-host/api/bots` lists three bots.
4. Run a demo match against the deployed host:
   `npm run ludo:demo -- --url https://your-host`, then settle it and read the
   reconcile report. Every difference must be zero.
5. Apply the load test once against the deployed host and record the numbers in
   `docs/LOAD_TEST.md` under "Measured". A number nobody recorded is a number
   nobody will notice degrading.

## Ops runbook

| Symptom                           | First move                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Prices look wrong on one market   | `POST /api/admin/markets/suspend` for that market type, then reprice                                             |
| The book is losing money fast     | `POST /api/admin/money/betting/pause` with `{"paused": true}`; the flag survives a restart                       |
| A match will not settle           | read `/api/admin/health-deep`, then the `alerts` rows; a refused verification is reported with its failing check |
| A payout is held                  | it is above `LARGE_PAYOUT_MINOR`: approve or reject it with the money endpoint, which writes an audit row        |
| Someone is guessing the admin key | the lockout is automatic after 10 attempts; the alert names the address                                          |

## Rollback

The image is tagged per commit. Rolling back the process is safe for money: the
ledger is append-only and every settlement is keyed by bet id, so a re-run after a
rollback is a no-op rather than a second payout. Rolling back a **migration** is
not: write a new migration that reverses the change, because `011` onward may be
in use by rows the previous version cannot read.
