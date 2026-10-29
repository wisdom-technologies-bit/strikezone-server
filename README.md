# strikezone-server

Game and betting server for **Strikezone**, an online skill-game betting platform
(Carrom first, then Ludo).

The rules that govern all work in this repository live in [AI_RULES.md](./AI_RULES.md).
Read them before changing anything.

## Stack

| Concern    | Choice                                                          |
| ---------- | --------------------------------------------------------------- |
| Language   | TypeScript (strict), Node 20+                                   |
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

| Script               | What it does                                       |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | `tsx watch` on `src/index.ts` (restarts on change) |
| `npm run build`      | Type-check and compile `src` to `dist`             |
| `npm start`          | Run the compiled server from `dist`                |
| `npm test`           | Vitest, single run                                 |
| `npm run test:watch` | Vitest in watch mode                               |
| `npm run lint`       | ESLint                                             |
| `npm run format`     | Prettier write                                     |
| `npm run typecheck`  | `tsc --noEmit` over sources and tests              |

## Environment variables

Every value is read through `src/lib/env.ts` and validated with zod. Nothing is
hard-coded and nothing is logged.

| Variable                    | Required | Default | Notes                                                         |
| --------------------------- | -------- | ------- | ------------------------------------------------------------- |
| `NODE_ENV`                  | yes      | -       | `development`, `test` or `production`                         |
| `PORT`                      | yes      | -       | Shared by the HTTP API and the Colyseus WebSocket server      |
| `SITE_ORIGIN`               | yes      | -       | The website's URL; the only allowed CORS and WebSocket origin |
| `SUPABASE_URL`              | yes      | -       | Supabase project URL                                          |
| `SUPABASE_SERVICE_ROLE_KEY` | yes      | -       | Bypasses RLS. Server-side only, never shipped to a client     |
| `RESULT_SIGNING_SECRET`     | yes      | -       | Signs match results (>= 32 chars)                             |
| `ADMIN_API_KEY`             | yes      | -       | Authenticates admin API calls (>= 24 chars)                   |
| `MONEY_MODE`                | yes      | -       | `virtual` or `real`                                           |
| `CURRENCY`                  | no       | `NGN`   | ISO 4217 code; NGN amounts are integers in kobo               |
| `HOUSE_MARGIN_BPS`          | no       | `600`   | Basis points, so 600 = 6.00%                                  |

In development `http://localhost:3000` is allowed in addition to `SITE_ORIGIN`,
so the website can run locally against this server.

## HTTP endpoints

| Endpoint      | Status              | Response                                                           |
| ------------- | ------------------- | ------------------------------------------------------------------ |
| `GET /health` | 200 while running   | `{ "ok": true, "version": "0.1.0", "uptimeSeconds": 42 }`          |
| `GET /ready`  | 200 when ready, 503 | `{ "ok": true, "checks": { "draining": "up", "supabase": "up" } }` |

`/health` never touches the database, so a database outage does not restart an
otherwise healthy process. `/ready` runs the Supabase connection test (a
PostgREST root request, which needs no table to exist yet) and also reports 503
once a shutdown has begun, so a load balancer stops sending new matches to a
draining instance.

The Colyseus WebSocket endpoint shares the same port and the same HTTP server.
Upgrade requests from any origin other than the allowlist are rejected with 403
before the handshake.

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
  api/              HTTP routes: /health, /ready
  engines/carrom/   pure Carrom rules
  engines/ludo/     pure Ludo rules
  rooms/            Colyseus rooms
  tournaments/      brackets, rounds, progression
  odds/             odds model and simulator
  betting/          bets, markets, liability
  wallet/           wallet ledger (the only place money changes)
  admin/            admin operations
  lib/              env, logger, supabase, origins, lifecycle, shutdown, version
supabase/
  migrations/       numbered SQL migrations (applied by a human)
  tests/            local Postgres shim + SQL behaviour checks for the migrations
tests/                Vitest suites
```

## Task log

### Scaffold - project skeleton, config, health and readiness

Added:

- Toolchain: `package.json` (TypeScript strict, ESM, Node 20+), `tsconfig.json`
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
canonical result plus the *head* of the chain. Signing the head as well as the
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
