# src/lib

Shared infrastructure with no game rules in it.

- `env.ts` - loads and validates every environment variable with zod and exports
  the typed `env` object. The process refuses to start if one is missing.
- `logger.ts` - pino structured logging; any key containing secret, key or token
  is redacted before the line is written.
- `supabase.ts` - the single server-side Supabase client (service role key) and
  `checkSupabaseConnection()`, used by `GET /ready`.
- `origins.ts` - the origin allowlist shared by CORS and the Colyseus WebSocket
  origin check.
- `lifecycle.ts` - `isShuttingDown()`, so rooms and routes can refuse new work
  while draining.
- `shutdown.ts` - graceful shutdown: stop accepting rooms, let matches finish for
  up to 30 seconds, then exit.
- `version.ts` - the version reported by `GET /health`.

`fair-rng.ts` (the seeded provably fair generator required by AI_RULES.md hard
rule 3) will live here before any game code is added.
