# src/engines/carrom

The carrom rules engine. Pure code: no network, no database, no clock, no random
numbers, and no knowledge of bets or stakes (AI_RULES.md). Everything it needs
comes in through its arguments, and everything it produces is plain JSON.

`docs/carrom-rules.md` is the specification: the rules implemented, the physics
model, the conventions, and the open questions with the interpretation chosen for
each.

## Public API (`index.ts`)

| Export                                              | What it does                                            |
| --------------------------------------------------- | ------------------------------------------------------- |
| `createInitialState(config, seed)`                  | A new match: standard formation, white to break, 0-0.   |
| `getLegalStrikerRange(state, config?)`              | The baseline and legal x range for the player to shoot. |
| `applyShot(state, shot, options?)`                  | Plays one shot. Returns `{ state, events, frames }`.    |
| `findLegalStrikerX(state, preferredX, config?)`     | Nearest legal striker x, for bots and demos.            |
| `isLegalStrikerPlacement(state, position, config?)` | Whether a striker position is legal.                    |
| `resolveShot(state, outcome, config)`               | Rules only, from `rules.ts`: no physics.                |
| `DEFAULT_CARROM_CONFIG`, `resolveConfig(overrides)` | Tunables, and a validated merge of them.                |

`shot` is `{ strikerPosition: { x, y }, angle, power }`: millimetres on the
player's baseline, radians, and a fraction of the maximum flick speed. It is
validated with zod (unknown fields rejected); an illegal placement throws a
`RangeError` rather than being silently moved.

`options` carries `config`, `recordFrames` and `fps`. Frames are off by default:
a recording is far larger than the state, and the odds simulator does not need it.

Events, each carrying its shot number: `coin_pocketed`, `queen_pocketed`,
`queen_covered`, `queen_returned`, `foul`, `turn_changed`, `board_ended`,
`match_ended`. Types are a discriminated union, so a `switch` over `type` is
exhaustive and no event needs casting.

`BotPolicy` is the interface a bot implements: `chooseShot(state, rng, skill,
config?)`. No bot is implemented here, on purpose: AI_RULES.md keeps bots out of
the game code, and the policy only ever sees the state, never the markets.

## Files

| File         | Contents                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`  | Every tunable: board 740 mm, pocket 45 mm, coin 31 mm, striker 41 mm, masses, restitutions, friction, step `1/240` s, match limits. Tune here. |
| `types.ts`   | State, shot, event, frame and `BotPolicy` types. The state is a small plain-JSON object.                                                       |
| `setup.ts`   | Opening formation, baselines, pocket centres, the free-spot spiral for returned coins.                                                         |
| `physics.ts` | The custom circle physics: fixed timestep, friction, walls, pairwise impulses, pocket capture, optional 30 fps frames.                         |
| `rules.ts`   | Turn flow, the queen, fouls and penalties, board and match scoring. Pure, so it is tested with made-up outcomes.                               |
| `index.ts`   | The public API, zod shot validation, and the placement checks.                                                                                 |

## Determinism

No `Math.random`, no `Date.now`, fixed timestep, fixed iteration order, and a
hard cap on how long a shot may run. The same state and shot give a byte-identical
result; `tests/carrom/determinism.test.ts` asserts it for one shot and for a
twelve-shot sequence.

## Test it

```bash
npm test -- tests/carrom      # rules, physics, scoring, determinism, performance
npm run carrom:demo           # a whole board with random legal shots
npm run carrom:demo -- --seed my-seed --max-shots 400
```

The performance test prints how long a twenty-shot board takes without frames and
fails if it is over 20 ms.
