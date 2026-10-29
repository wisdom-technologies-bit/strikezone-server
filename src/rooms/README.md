# src/rooms

Colyseus room classes for live matches.

A room owns a match: seats, the engine instance, turn timers, reconnection and
the result it emits at the end. Rooms are the only place game sessions and
clients meet.

Constraints from AI_RULES.md:

- Rooms never read bets, stakes or liability (hard rule 4). A room receives a
  match id and seat assignments; the betting side resolves payouts from the
  signed result.
- Every incoming room message is validated with zod and unknown fields are
  rejected (hard rule 6).
- All randomness comes from the seeded generator in `src/lib/fair-rng.ts`
  (hard rule 3).
- A draining process refuses new rooms and finishes what is running, up to 30
  seconds (see `src/lib/shutdown.ts`).

Files:

- `carrom-match-runner.ts` - the referee. Owns one match: rules, clock, bots,
  timeouts, forfeits and the log. Deliberately not a room, so a whole match can be
  played and verified in a test with no server and no socket.
- `carrom-room.ts` - the Colyseus room: auth, zod-validated messages, spectator
  guard, state mirroring, reconnection. It decides nothing itself.
- `carrom-room-schema.ts` - the room state, declared with `@colyseus/schema` 5's
  `schema()` builder so no decorator settings are needed.

A client sends `{ type: "shot", shot: { strikerPosition, angle, power },
expectedShot? }` and nothing else. Everything else is the referee's.
