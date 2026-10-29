# AI_RULES.md

## PROJECT
- Language: TypeScript (strict mode), Node 20+.
- Realtime: Colyseus for game rooms over WebSocket.
- Database: Supabase Postgres, accessed from the server with the service role key via @supabase/supabase-js. You do not have database access. Never try to create tables from code. Write SQL migration files in /supabase/migrations and I will run them.
- Tests: Vitest. Every engine and money function needs unit tests.
- Lint/format: ESLint and Prettier. No default exports. No any.

## STRUCTURE
- /src/engines/carrom and /src/engines/ludo: pure rules code with no network or database imports, so the odds simulator can reuse them.
- /src/rooms: Colyseus rooms.
- /src/tournaments, /src/odds, /src/betting, /src/wallet, /src/admin, /src/api, /src/lib.
- /supabase/migrations: SQL files, numbered.

## HARD RULES
1. LICENSES: never copy, translate or closely paraphrase code from any GPL or unlicensed repo, including samiranrl/Carrom_rl. You may read such repos to understand rules, geometry and interfaces, then write original code. Put a short comment at the top of any engine file that was informed by a reference, naming the reference and stating the code is original.
2. MONEY: all money amounts are integers in the smallest unit (kobo for NGN, or coins). Never use floating point for money. All money changes go through the wallet ledger module and nowhere else.
3. RANDOMNESS: all game randomness comes from the seeded provably fair generator in /src/lib/fair-rng.ts. Never call Math.random in game, bot or odds code.
4. SEPARATION: game rooms and bots must never read bets, stakes or liability. Only /src/odds and /src/betting may read betting data.
5. SECRETS: read all secrets from environment variables through /src/lib/env.ts, validated with zod. Never hard-code keys, never log them, never commit .env files.
6. Every endpoint and room message is validated with zod. Reject unknown fields.
7. Small commits per task, with a README section describing what was added and how to test it.
