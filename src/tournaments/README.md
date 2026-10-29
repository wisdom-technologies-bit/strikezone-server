# src/tournaments

Tournament structure and progression: brackets, round scheduling, entry rules,
seeding and how a finished match advances a player.

Tournaments orchestrate rooms and read results; they do not implement game rules
and do not move money themselves. Any payout goes through `src/wallet`.

## The pieces

| File                    | What it owns                                                               |
| ----------------------- | -------------------------------------------------------------------------- |
| `types.ts`              | The vocabulary: statuses, entry states, the zod config an admin fills in   |
| `seeding.ts`            | Bracket order (1v8, 4v5, 2v7, 3v6...) and who gets the byes                |
| `format.ts`             | The strategy seam: plan, `nextSeat`, `summarise`                           |
| `single-elimination.ts` | 2 to 64 players, byes to the best seeds                                    |
| `round-robin.ts`        | 3 to 8 players, every pair once, circle method                             |
| `prizes.ts`             | The rake, the split, the bot prize policy. Integer maths that must balance |
| `repository.ts`         | Every read and write, behind one interface, in memory and on Supabase      |
| `service.ts`            | The lifecycle: register, withdraw, cancel, start, launch, settle, pay      |
| `scheduler.ts`          | The ten-second job, behind a lease, that drives all of the above           |
| `launcher.ts`           | Opening the room that plays a match                                        |

## Game agnosticism

Nothing in `types.ts`, `seeding.ts`, `format.ts`, the two formats or `prizes.ts`
knows any game exists. The only game-specific code is `launcher.ts`, which maps a
game name to a Colyseus room name, and one branch in `service.launchDue` that
declines to launch a game with no room yet.

Adding Ludo is therefore: write the room, add it to `ROOM_NAMES`, allow `ludo` in
`TOURNAMENT_GAMES` (it is already allowed). Adding Swiss is: one file answering
`plan`, `nextSeat` and `summarise`, and one line in the `FORMATS` map.

## Adding a format

The seam is three questions:

- `plan(entrants)` - the whole schedule: which position sits in which round and
  slot, which seeds start in it, and where its winner goes.
- `nextSeat(position)` - where that winner lands. Round robin returns null because
  every pairing is already scheduled.
- `summarise(plan, positions, entrants)` - done or not, and the finishing order
  when done. Prizes are paid from that order, so it must be total and stable.

`tests/tournaments/bracket.test.ts` runs both formats over every entrant count the
server accepts and checks the structural invariants (every seed once, each pair
once, each round halves, byes to the best seeds). A new format must pass the same
shape of test before it is usable.

## The lifecycle

```
draft --(open)--> registration --(start)--> running --(final decided)--> finished
                        |                        |
                        +---(withdraw)-----------+
                        +---(cancel)-----------> cancelled
```

- **Registration** charges the entry fee from the player's wallet to this
  tournament's prize pool account, in one ledger transaction keyed on the
  tournament and the player. A double tap charges once.
- **Start** seeds the entrants by rating, fills a short field with labelled bots
  when `fillWithBots` is set, writes the whole schedule, and decides the byes
  immediately so the published bracket already reads correctly.
- **Running**: a position becomes ready when both seats are known, is launched when
  its due time arrives, and is decided by the match result or by the walkover rule.
- **Finished** when the format says so. The rake, the split and the bot prize
  policy are applied once, in one ledger transaction keyed on the tournament.

## The three rules that keep it honest

**Conditional writes.** Every transition that could race is a conditional update:

- `transition(id, from, to)` - only one caller moves a tournament out of a status,
  so only one server generates a bracket.
- `claimPosition(id, at)` - only one caller takes a launch claim, so a match is
  never launched twice.
- `completePosition(id, result, at)` - only one caller decides a position, so a
  result is never recorded twice.

The rest is idempotent by key: an entry, a refund and a payout each carry a key, so
repeating the call returns the first transaction instead of moving money again.

**The bracket is written once.** `insertPositions` is all-or-nothing and the
(round, slot) pair is unique, so a second generator gets a conflict rather than a
half-written bracket.

**A walkover is a decision, not a coincidence.** A human who has not connected
`walkoverSeconds` after the match was due loses it. The joiner is read from
`matches.seat_1_joined_at`, which the room writes on the first join. Bots never
need to turn up, and if both humans fail to, the better placed seat advances so a
tournament cannot stall on two no-shows.

## Money

One expense, one prize, one rake, all through `src/wallet`:

| Moment       | Kind               | Ref type            | Key                                   |
| ------------ | ------------------ | ------------------- | ------------------------------------- |
| Entry fee    | `tournament_entry` | `tournament`        | `<tournament>:<player>:entry`         |
| Withdrawal   | `adjustment`       | `tournament_refund` | `<tournament>:<player>:refund`        |
| Cancellation | `adjustment`       | `tournament_refund` | `<tournament>:<player>:cancel_refund` |
| Prizes       | `tournament_prize` | `tournament`        | `<tournament>:payouts`                |

The prize transaction has one leg per winner, one for the pool and one for the
house when the house keeps anything, and it sums to zero by construction: the rake
and any unclaimed prize are part of the house leg.

A bot's prize never pays a bot. `botPrizePolicy` either passes it down to the
best-placed human below (`next_human`) or leaves it with the house
(`house_keeps`), and a tournament with no humans at all leaves the pool with the
house. `computePrizes` throws rather than return a split that does not add up to
the pool.

## The scheduler

`TournamentScheduler.tick()` asks one question - what is due? - and does it: opens
a draft whose registration time has come, starts one whose start time has come,
launches due matches, settles finished ones.

It runs under a lease (`scheduler_leases`, taken with a Postgres advisory lock in
one statement), so one instance works at a time. Even if the lease fails, the
conditional writes above mean a duplicate tick cannot launch a match twice or pay
a tournament twice, which `tests/tournaments/scheduler.test.ts` proves with a
lease that always says yes.

`resume()` on startup is a tick. Nothing about a tournament lives in memory, so a
server that dies in the middle of round two picks up exactly there - the bracket,
the results and the money are all rows.
