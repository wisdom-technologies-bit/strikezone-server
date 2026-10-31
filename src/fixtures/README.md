# House fixtures

The bot matches that keep the lobby bettable, and the lifecycle around them.

A fixture is **not a new kind of match**. It is a row in `matches` with no
tournament and every seat a bot, played by the same room, priced by the same
pricer and settled by the same settlement as a match a person created. What this
folder adds is a supply of them and the things that have to happen around a start
time.

## What it does, in the order it happens

1. **Top up.** Every tick, the scheduler counts the fixtures that are still
   `scheduled` and creates more until `UPCOMING_FIXTURES_TARGET` are waiting,
   spaced `FIXTURE_INTERVAL_MINUTES` apart. A cold start seats the first one
   `BET_WINDOW_SECONDS` out, so the lobby has a price immediately rather than an
   empty state for a whole interval.
2. **Price.** Each fixture is priced the moment it is created, at the full
   simulation count, and falls back to the reduced count with a warning when the
   host cannot afford the full one in time (see "Measured costs").
3. **Close and launch.** At its start time the fixture's pre-match-only markets
   are closed, `match.live` is published, and the room is launched with the
   fixture's own seed. If `MAX_CONCURRENT_HOUSE_MATCHES` games are already
   running, the fixture waits and says so.
4. **Hand over.** The tick after a fixture finishes publishes `match.finished`,
   which is what closes the book and hands the markets to settlement.

## Three properties it is built to keep

- **Safe to run twice.** A lease (`house_fixture_scheduler`, its own lock key, so
  it never contends with the tournament scheduler) decides which instance ticks,
  and every write is conditional on the state it was read in.
- **Resumes.** Nothing needed to finish a fixture lives only in memory. The
  fixtures are match rows, the pause is a row, and the seed is derived from the
  match id with `RESULT_SIGNING_SECRET`, so a process that died between pricing a
  match and starting it picks both up from the database. On startup the
  scheduler also hands over anything that finished while it was down, bounded to
  the last six hours; settlement is idempotent, so a match handed over twice is
  paid once.
- **Never exceeds its share.** No more than `MAX_CONCURRENT_HOUSE_MATCHES` bot
  matches run at once. A due fixture that cannot start keeps its place.

## The roster

Carrom pairs different skill tiers (rookie vs club, club vs master, rookie vs
master) and Ludo seats four distinct house bots mixing the three policies. Both
rotate one step per fixture, so two fixtures in a row are not the same match, and
the prices differ because the pairings do. Bot identities are keyed on display
name, so four Ludo seats are four names: one name in four seats is one player
seated four times, which the database refuses.

## Settings

| Variable                       | Default       | What it does                                         |
| ------------------------------ | ------------- | ---------------------------------------------------- |
| `FIXTURES_ENABLED`             | `false`       | The switch. Off means the code is deployed and idle. |
| `UPCOMING_FIXTURES_TARGET`     | `4`           | Fixtures kept `scheduled`. `0` stops creation.       |
| `FIXTURE_INTERVAL_MINUTES`     | `5`           | Spacing between start times.                         |
| `BET_WINDOW_SECONDS`           | `120`         | The first window's length on a cold start.           |
| `MAX_CONCURRENT_HOUSE_MATCHES` | `2`           | Bot matches allowed to run at once.                  |
| `FIXTURE_GAMES`                | `carrom,ludo` | The games, alternating in this order.                |

## Operator controls

- `GET /api/admin/fixtures` (the admin key): enabled, paused, how many are
  upcoming and running, the cap, the interval, the window, the games, and when
  the next one starts.
- `POST /api/admin/fixtures/pause` and `/resume`: the pause switch. A pause stops
  **new** fixtures being created; a fixture already scheduled still starts,
  because people may already have bet on it. Both write an audit row through the
  admin gate, and both are recorded in `fixture_controller` with the actor.

Migration `012_house_fixtures.sql` creates the pause row. Without it the
scheduler runs unpaused and logs that the migration is outstanding, which is the
safe direction: a missing pause switch must not stop the lobby being supplied.

## Measured costs

On the development host, one fixture priced at the defaults:

| Game                    | Simulations                             | Time   | Selections     |
| ----------------------- | --------------------------------------- | ------ | -------------- |
| Carrom (rookie vs club) | 100,000                                 | 11.7 s | 231 (30 types) |
| Ludo (four house bots)  | 200,000 (reduced from 1M by the budget) | 43.5 s | 275 (26 types) |

`npm run fixture:price` prints the same table against an in-memory store, so a
host can be measured before it is trusted with a five minute interval.

## Tests

- `tests/fixtures/scheduler.test.ts`: fill, spacing, alternation, the start
  hand-over, the concurrency cap, two instances ticking at once, a restart, and
  the pause.
- `tests/fixtures/lifecycle.test.ts`: one fixture played by the real Ludo runner,
  verified by the real verifier, settled through the production subscriber, with
  escrow empty and the books summing to zero afterwards.
- `tests/api/contract.test.ts`: a four seat lobby row with its winner market.
