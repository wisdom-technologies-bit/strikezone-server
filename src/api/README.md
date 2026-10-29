# src/api

HTTP surface of the server, mounted on the Express app built in `src/app.ts`.

Current routes:

- `GET /health` - liveness. Always 200 while the process serves HTTP.
- `GET /ready` - readiness. 200 only when the process is not draining and the
  Supabase connection test passes.
- `GET /api/bots` - the bot catalogue: every published level with its display
  name, policy id and the numbers it plays with. `isBot: true` always.
- `GET /api/matches/:id/replay` - the public record of a match: seats, the
  hash-chained events, whether the chain verifies, and the result. The seed is
  revealed here only once the match has finished.
- `POST /dev/start-match` - development only, and not mounted in test or
  production. Starts a bot match, commits to a fresh seed, opens its room and
  returns the ids needed to watch and verify it.

Conventions: every request body, query and param is validated with zod and
unknown fields are rejected (AI_RULES.md hard rule 6). Route handlers return
small JSON objects and never expose secrets or raw database errors.
