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

Game and match support:

- `fair-rng.ts` - the only source of game randomness (AI_RULES.md hard rule 3):
  match seeds, their commitments, per-draw HMAC randomness, gaussian noise, and
  the older seeded generator used where only reproducibility is needed.
- `canonical-json.ts` - stable JSON serialisation, so a hash means the same thing
  on both sides.
- `match-log.ts` - the hash-chained, append-only record of a match, and the HMAC
  result signature over its head.
- `match-repository.ts` - everything a match reads or writes, as one interface
  with Supabase and in-memory implementations.
- `match-store.ts` - the process-wide store, resolved lazily so importing it never
  builds a Supabase client.
- `match-verify.ts` - independent verification of a finished match: commitment,
  chain, per-shot replay, final score and signature.
