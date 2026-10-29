# src/engines

Pure rules engines. Carrom lives in `carrom/`, Ludo in `ludo/`.

Engine code is **pure**: no network, no database, no `@supabase/supabase-js`, no
Colyseus, no clock or `Math.random`. Each engine takes a state plus a command and
returns the next state, so the same code can run inside a room, inside a bot and
inside the odds simulator without dragging a server along.

Randomness arrives as an injected value produced by `src/lib/fair-rng.ts`
(AI_RULES.md hard rule 3). Money, bets and stakes never reach an engine
(hard rule 4).

Any engine file informed by a reference implementation (for example a carrom
rules or geometry repo) starts with a comment naming that reference and stating
that the code is original (hard rule 1).
