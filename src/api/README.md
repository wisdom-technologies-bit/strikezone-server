# src/api

HTTP surface of the server, mounted on the Express app built in `src/app.ts`.

Current routes:

- `GET /health` - liveness. Always 200 while the process serves HTTP.
- `GET /ready` - readiness. 200 only when the process is not draining and the
  Supabase connection test passes.

Conventions: every request body, query and param is validated with zod and
unknown fields are rejected (AI_RULES.md hard rule 6). Route handlers return
small JSON objects and never expose secrets or raw database errors.
