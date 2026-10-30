# src/odds

Odds model and the simulator that calibrates it.

This is where the house margin (`HOUSE_MARGIN_BPS`, 600 = 6.00%) is applied. The
simulator reuses the pure engines from `src/engines` to estimate outcome
probabilities without a network or a database.

`src/odds` is one of only two places allowed to read betting data
(AI_RULES.md hard rule 4). It reads finished matches, player skill and the match
event stream, and it writes to `markets` and nothing else.

## The pieces

| File                   | What it does                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `calibrate.ts`         | Measures the shot table with the real engine: 2000 shots per cell.                  |
| `shot-grid.ts`         | The grid itself: distance buckets, cut buckets, aim-error levels.                   |
| `shot-table.ts`        | Loads `data/shot-table.json` and answers "does this shot pot?".                     |
| `skill.ts`             | What we believe about a player: bots' published numbers, humans shrunk to Club.     |
| `stats.ts`             | `MatchStats`: everything a market settles against, from the event log.              |
| `carrom-fast-model.ts` | A whole match without physics, seeded and reproducible.                             |
| `validation.ts`        | Fast model against the real engine, pairing by pairing, with tolerance.             |
| `catalog/carrom.ts`    | The 30 market types: selections, settlement, push and void rules.                   |
| `catalog/lines.ts`     | Every default line, in one place.                                                   |
| `pricer.ts`            | Simulations to probabilities to odds, clamped, with the margin check.               |
| `markets-store.ts`     | The `markets` table: upsert, list, suspend, close.                                  |
| `live.ts`              | In-play: suspend on a shot, reprice at most once a second, publish ready-to-settle. |
| `backtest.ts`          | Model probabilities against matches that really finished, in ten point buckets.     |
| `config.ts`            | Simulation counts, stake ceilings by tier, probability and odds bounds.             |

## Scripts

| Script                   | What it does                                               |
| ------------------------ | ---------------------------------------------------------- |
| `npm run odds:calibrate` | Re-measures the shot table (about five seconds).           |
| `npm run odds:validate`  | Fast model vs real engine: wins, points, boards and fouls. |
| `npm run odds:fit`       | Sweeps the model's constants against the real engine.      |
| `npm run odds:backtest`  | Scores the model against finished matches in the database. |

## Pricing a market

1. The match and its two seats decide the skills. Bots carry published numbers;
   a human without history is priced as Club until `skill.ts` has their matches.
2. 100,000 matches are simulated from the seed `${matchId}:price`, so the same
   match prices the same twice while nothing has changed.
3. Every selection's probability is the share of simulations in which it won,
   voids excluded, floored at 1.5%.
4. `odds = floor(100 / (p * (1 + margin))) / 100`, clamped to 1.01 and 1000.
5. A market whose `1/odds` sums further than one percent from `1 + margin` is
   logged as a warning. Near-certain selections hit the 1.01 floor and multiway
   markets lose a little to the rounding down; both are expected, and both warn.

## In play

A shot suspends the match's markets, a reprice runs, and the book reopens when
the suspension window ends. Repricing is throttled to once a second per match,
and a repricing whose shot is already stale is dropped rather than written over
newer numbers. When the match ends the engine publishes `markets.ready_to_settle`
with the stats and settles nothing itself: settlement belongs to the betting side.

## Measured against the database

`npm run odds:verify` creates a bot match in the real database and acts as the
room: it publishes `match.created`, plays the match through the runner with a
`match.shot` per shot, and publishes `match.finished`. Last run, Club against
Rookie:

- 231 rows priced across all 30 market types in 12 seconds, every one open;
  the spec budget is twenty seconds for a 100,000-simulation price.
- 231 shots played in 32 seconds, repriced in play under a 2.5 second throttle,
  every market suspended while the shot was being priced and reopened after.
- 231 rows closed at the finish, and one `markets.ready_to_settle` with the
  winner and the boards played.

Three things that only showed up against the real table:

1. `markets.fair_probability` is bounded strictly inside (0, 1), so a selection
   that never lost in simulation has to be capped below one. `MAX_PROBABILITY`
   (0.985) is that ceiling.
2. The bot player is a real row with a unique display name, so the second match
   of a level must seat the same bot. `SupabaseMatchRepository.create` looks the
   bot up before inserting.
3. A reprice can outlive the match it belongs to. The suspension timer from the
   last shot would reopen a closed book, and a price written after the finish
   left the rows suspended. The engine now remembers finished matches, cancels
   their suspensions, waits for in-flight prices before closing, and refuses to
   reopen or reprice a finished match. `tests/odds/live.test.ts` pins it.

## Known defects, deliberately recorded

1. **The shot table is not monotone cell by cell.** Shots that cannot be played
   from a legal baseline leave cells empty, and those cells are filled from their
   neighbours, so an easier cell can carry a harder cell's number. The table is
   only claimed in aggregate: about 16% for a six degree aim error, about 31% for
   the best hands, clamped at 0.75.
2. **The fast model clears a board too quickly.** Against the real engine, win
   probabilities now agree closely (0.0pp, -0.2pp and -4.2pp over 40 engine
   matches per pairing), but the model finishes a match in 4.2-5.9 boards where
   the engine takes 6.1-7.9, and its points per board are higher. One skill
   channel drives both who clears first and how many coins the loser leaves; the
   fix is to split clearance from coin retention, which is not done.
3. **In-play prices do not yet condition on the state of the match.** A reprice
   re-simulates from the start, so a 20-4 lead does not move the match winner
   price as it should. The suspension, the throttle and the stale-job drop all
   work; only the conditioning is missing.
4. **A reprice rewrites all 231 rows.** Each write is one upsert, but it is
   seconds of latency against a remote database, so the throttle inside a match
   has to be generous (2.5s in the verification) or the prices starve the match
   they are pricing. Writing only the rows whose price moved, or batching into
   one transaction per market type, is the fix.
5. **Human history is not loaded yet.** `skill.ts` can shrink samples, but the
   pricer does not read a player's last 30 matches, so every human prices as Club.
