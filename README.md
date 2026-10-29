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
supabase/migrations/  numbered SQL migrations (applied by a human)
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

No game logic exists yet: there are no rooms, no engines and no betting code.
