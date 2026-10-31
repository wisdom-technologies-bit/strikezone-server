# Website handoff

Everything here was read from the server's code and checked against the running
deployment, not written from memory. Where something does not exist yet, it says
so rather than describing what it ought to be.

The site is a Supabase-authenticated client that reads public data over REST,
subscribes to a few tables directly over Supabase Realtime, and joins a Colyseus
room over WebSocket to watch or play. No server secret ever goes to the browser.

---

## 1. Base URLs and endpoints

| What                       | Value                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| REST base                  | `https://strikezone-server-ex45.onrender.com`                      |
| Health                     | `GET https://strikezone-server-ex45.onrender.com/health`           |
| WebSocket                  | `wss://strikezone-server-ex45.onrender.com` (bare origin, no path) |
| Allowed site origin (CORS) | `https://strikezone-bet.vercel.app`                                |
| Supabase project           | `https://xbgiifdhpdkyirmyydwc.supabase.co`                         |

**REST.** Every endpoint answers JSON. Success bodies carry `ok: true`, failures
`ok: false` with an `error` string:

```json
{ "ok": false, "error": "not_found" }
```

**WebSocket.** Colyseus 0.18. Construct the client with the **bare origin**, never
with a path:

```ts
import { Client } from "@colyseus/sdk";

const client = new Client("wss://strikezone-server-ex45.onrender.com");
```

The SDK appends `matchmake/<action>/...` to whatever base it is given, and the
matchmaker is mounted at the root. A path-suffixed base makes every join answer
`404 not_found` while the room exists. This has already bitten the two dev
viewers once.

Room names: `"carrom"` and `"ludo"`. There is no `rooms` listing used by the site;
a spectator joins by room id, which the site gets from the match.

**Join options.** The room validates the join body with a strict Zod schema, so
unknown keys are rejected outright.

```ts
// A player joining their own seat
await client.joinById(roomId, { matchId, token: supabaseAccessToken });

// A spectator
await client.joinById(roomId, { matchId, spectate: true });

// A spectator, with the token too (optional for spectators)
await client.joinById(roomId, { matchId, token, spectate: true });
```

The server side of that schema is `ludoRoomOptionsSchema` / `carromRoomOptionsSchema`:
`matchId` (string, 1 to 64 chars), `token` (10 to 4096), `spectate` (boolean),
`allowSpectators` (boolean, server side creation only), `seed` (server only).

A client that is not seated and did not ask to spectate is treated as a spectator.
Carrom joins additionally accept `seats` (an array of exactly two) and
`turnSeconds` (5 to 300).

**Cold starts.** The Render instance is a single always-on container, but a free
plan can idle out. The first request after an idle period can take 30 to 60
seconds. The site should show a "waking up" state on the first call rather than a
timeout error.

---

## 2. Auth

The site authenticates people with Supabase Auth. The server does not issue
tokens; it verifies the ones Supabase issued.

**REST.** Send the Supabase access token as a bearer token:

```http
GET /api/me/wallet HTTP/1.1
Authorization: Bearer <supabase access token>
```

**WebSocket.** Send the same token as a join option, `{ token }`. The room
verifies it and seats the client, or refuses the join.

**Route classes.**

| Class   | How it is checked                      | Who calls it                           |
| ------- | -------------------------------------- | -------------------------------------- |
| Public  | no auth                                | the browser, anyone                    |
| User    | `Authorization: Bearer <supabase jwt>` | the signed-in browser                  |
| Admin   | `x-admin-key: <key>`                   | your back office only, never a browser |
| Webhook | provider signature                     | the payment provider                   |
| Dev     | `NODE_ENV=development` only            | local development                      |

The admin key is compared in constant time, lockouts after repeated wrong keys,
and every call is written to an audit table. **It must never be shipped to the
browser.** An admin call from a page would have to go through a server you
control, which holds the key and re-checks that the caller is an admin.

---

## 3. Routes

### Public

| Method | Path                       | Request | Response                                            |
| ------ | -------------------------- | ------- | --------------------------------------------------- |
| GET    | `/health`                  | none    | `{"ok":true,"version":"0.1.0","uptimeSeconds":237}` |
| GET    | `/api/config`              | none    | money and limit settings                            |
| GET    | `/api/bots`                | none    | the published bots                                  |
| GET    | `/api/matches/:id`         | none    | one match with players                              |
| GET    | `/api/matches/:id/markets` | none    | every market for the match                          |
| GET    | `/api/matches/:id/replay`  | none    | the log, the result and a chain check               |
| GET    | `/api/players/:id`         | none    | one player's profile                                |
| GET    | `/api/leaderboard`         | none    | top players                                         |
| GET    | `/api/tournaments`         | none    | tournament list                                     |
| GET    | `/api/tournaments/:id`     | none    | one tournament                                      |

```json
// GET /api/config
{"ok":true,"currency":"XTS","moneyMode":"virtual","minStakeMinor":100,
 "maxStakeMinor":5000000,"houseMarginBps":600,"limits":{...}}
```

```json
// GET /api/matches/:id  (Ludo, finished)
{"ok":true,"match":{"id":"6b0b12a8-...","game":"ludo","status":"finished",
 "tournamentId":null,"isTournament":false,
 "startedAt":"2026-10-30T12:49:58.038+00:00",
 "endedAt":"2026-10-30T12:51:08.491+00:00","players":[...],"markets":[...]}}
```

```json
// GET /api/matches/:id/markets
{
  "ok": true,
  "matchId": "6b0b12a8-...",
  "markets": [
    {
      "id": "66086c69-...",
      "marketType": "ludo_match_winner",
      "subject": "",
      "line": null,
      "name": "ludo_match_winner",
      "status": "settled",
      "maxStakeMinor": 5000000,
      "isLive": false,
      "selections": [{ "selectionKey": "red", "oddsDecimal": 3.64, "status": "settled" }]
    }
  ]
}
```

Unknown paths answer `404 {"ok":false,"error":"not_found"}`. A malformed id
answers `400 {"ok":false,"error":"invalid_request","issues":[{"path":"id","message":"Invalid UUID"}]}`.
A failed read answers `503 {"ok":false,"error":"read_unavailable"}`.

### User

| Method | Path                   | Body / query                                                      | Response                                                                                      |
| ------ | ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| POST   | `/api/bets`            | `{marketId, stakeMinor, expectedOdds, idempotencyKey}`            | `201 {ok:true, bet, replayed}`                                                                |
| GET    | `/api/me/bets`         | none                                                              | `{ok:true, bets:[...]}`                                                                       |
| GET    | `/api/me/wallet`       | none                                                              | `{ok:true, currency, availableMinor, atRiskMinor, pendingWithdrawalMinor, totalBalanceMinor}` |
| GET    | `/api/me/transactions` | `?limit=20&cursor=<nextCursor>`                                   | `{ok:true, currency, transactions:[...], nextCursor}`                                         |
| GET    | `/api/me/limits`       | none                                                              | `{ok:true, limits, pending}`                                                                  |
| PUT    | `/api/me/limits`       | `{dailyDepositLimitMinor?, dailyLossLimitMinor?, maxStakeMinor?}` | the applied limits                                                                            |
| POST   | `/api/me/self-exclude` | `{hours}` (1 to 8760)                                             | the exclusion                                                                                 |
| POST   | `/api/deposits`        | `{amountMinor, provider?}`                                        | `201 {ok:true, deposit, redirectUrl, credited}`                                               |
| POST   | `/api/withdrawals`     | `{amountMinor, destination?}`                                     | `201 {ok:true, withdrawal}`                                                                   |
| GET    | `/api/withdrawals`     | none                                                              | `{ok:true, withdrawals:[...]}`                                                                |

### A brand-new player

A player who has never deposited or bet has no `wallet_accounts` row yet, and that is a normal
state rather than an error:

- `GET /api/me/wallet` answers `{ok:true, currency, availableMinor:0, atRiskMinor:0,
pendingWithdrawalMinor:0, totalBalanceMinor:0}`.
- `GET /api/me/transactions` answers `{ok:true, currency, transactions:[], nextCursor:null}`.
- `GET /api/me/bets` answers `{ok:true, bets:[]}`.
- `GET /api/me/limits` answers the defaults (three nulls) with `pending: null`.

The wallet account is created by the first money movement, which is a deposit or a bet stake,
never by a read. So the site shows zero as a balance and does not treat it as a failure; a
genuine database error still answers `503 {ok:false, error:"read_unavailable"}`.

```json
// POST /api/bets  {marketId, stakeMinor: 10000, expectedOdds: 3.64, idempotencyKey: "ui-8f2c-1"}
{
  "ok": true,
  "bet": {
    "id": "ca95db14-...",
    "marketId": "66086c69-...",
    "stakeMinor": 10000,
    "oddsLocked": 3.64,
    "potentialPayoutMinor": 36400,
    "status": "open",
    "placedAt": "2026-10-31T00:41:12.111Z"
  },
  "replayed": false
}
```

`idempotencyKey` is 8 to 200 characters. Reuse the same key for a retry of the
same bet; a different body under the same key answers `idempotency_conflict`.

**Bet refusal codes.** All come back as `409` with `{ok:false, error:<code>}`
unless noted. The site should branch on the code, not the message.

| Code                      | What the site shows                                     |
| ------------------------- | ------------------------------------------------------- |
| `invalid_request`         | 400. A field failed validation; list the `issues`       |
| `invalid_stake`           | Stake must be a whole number of minor units, above zero |
| `invalid_odds`            | Refresh the market; the price is malformed              |
| `invalid_idempotency_key` | Internal; regenerate the key                            |
| `idempotency_conflict`    | This bet was already placed with different terms        |
| `user_not_found`          | Session is stale; sign in again                         |
| `market_not_found`        | The market is gone; reload the match                    |
| `market_closed`           | Betting on this market has closed                       |
| `odds_moved`              | The price moved. Show the new price and a confirm again |
| `stake_below_minimum`     | Below the minimum stake from `/api/config`              |
| `stake_above_market_max`  | Above this market's `maxStakeMinor`                     |
| `stake_above_limit`       | Above the player's own max stake limit                  |
| `daily_loss_limit`        | The player's daily loss limit is reached                |
| `rate_limited`            | 429. Too many bets too fast; back off                   |
| `self_excluded`           | Self-excluded: show the end date, no betting UI         |
| `kyc_required`            | Identity check needed before betting                    |
| `insufficient_funds`      | Not enough available balance                            |
| `betting_paused`          | Betting is paused globally; show a banner               |
| `match_exposure_cap`      | This match has taken as much as it can                  |
| `global_exposure_cap`     | The book has taken as much as it can                    |
| `house_account_missing`   | Server misconfiguration; report, do not retry           |
| `escrow_account_missing`  | Server misconfiguration; report, do not retry           |

**Withdrawal refusal codes.** `409` except `not_found` which is `404`:

| Code                 | What the site shows                                  |
| -------------------- | ---------------------------------------------------- |
| `amount_invalid`     | Amount must be a whole number above zero             |
| `insufficient_funds` | Not enough available balance                         |
| `kyc_required`       | Identity check needed before withdrawing             |
| `account_too_new`    | Account must be older than `MIN_ACCOUNT_AGE_HOURS`   |
| `not_found`          | No such withdrawal                                   |
| `wrong_status`       | That withdrawal is already approved, paid or refused |

A blocked deposit or bet from the limits layer answers `409` with
`{ok:false, error:<code>, ...details}` where the code is one of `self_excluded`,
`daily_deposit_limit`, `kyc_required` or `account_too_new`. The deposits endpoint
uses exactly that shape for all four.

### Admin, webhook, dev

Admin routes are under `/api/admin/...` (`overview`, `health-deep`, `audit-log`,
`alerts`, `bots`, `bots/:botId/publish`, `bots/:botId/history`, `solvency`,
`reconcile`, `bankroll/topup`, `betting`, `betting/pause`, `markets/suspend`,
`markets/override`, `markets/:id/suspend`, `bets/pending-review`,
`bets/:id/approve`, `bets/:id/reject`, `withdrawals/:id/approve`,
`withdrawals/:id/paid`, `withdrawals/:id/reject`, `users/:userId/kyc`,
`users/:userId/freeze`, `tournaments`, `tournaments/:id/open`,
`tournaments/:id/cancel`). All need `x-admin-key`. The site does not call them.

`POST /api/webhooks/payments/:provider` is for the provider only.

`POST /dev/start-match` and `POST /dev/start-ludo` are mounted **only** when
`NODE_ENV=development`. They are not available on the deployment.

---

## 4. The live stream

Message types, from `STREAM_MESSAGES` in `src/api/contract.ts`:

| Type        | When                                | Payload                                                       |
| ----------- | ----------------------------------- | ------------------------------------------------------------- |
| `welcome`   | on join                             | `{matchId, spectate, fps}`                                    |
| `snapshot`  | on join, and after a lag            | the board and the state                                       |
| `shot`      | Carrom: a shot resolved             | `shotMessageSchema`                                           |
| `roll`      | Ludo: a die is on the table         | `{seat, roll, tokens, moveNumber, moveSeconds, forfeited}`    |
| `move`      | Ludo: a turn resolved               | `{seat, roll, moveNumber, token, from, to, events, turnSeat}` |
| `match_end` | the result is in                    | `endMessageSchema`                                            |
| `lag`       | this viewer fell behind             | `{type:"lag", skippedShots, reason:"slow_consumer"}`          |
| `rejected`  | a message from a client was refused | `{type:"rejected", reason}`                                   |

**Frames.** Colyseus sends the room state as encoded patches. Decode with the
contract, not by hand:

```ts
import { encodedFramesSchema, decodeFrames } from "../src/api/contract";
```

`encodedFramesSchema` validates what arrived, `decodeFrames` returns the decoded
state. The site should keep the whole stream pinned to that one module so a
protocol change breaks compilation rather than a game.

**Joining mid-shot.** A viewer who arrives while a shot is in flight gets
`welcome`, then a `snapshot` of the board as it stands, and then follows live
frames from the next shot. It is not sent the earlier shots. A viewer whose socket
buffer exceeds 1 MB is _skipped_ for that shot rather than queued, and is then told
with `lag` and how many it missed, followed by a fresh `snapshot`. That is
deliberate: one stuck phone must not slow the other 499.

**Limits.** `MAX_SPECTATORS_PER_ROOM` defaults to **2000** per room, and
`SPECTATOR_JOIN_PER_MINUTE` defaults to **60 joins per address per minute**. A
bot-triggered join burst from one IP will hit that second limit; the site should
back off and retry rather than treat it as fatal.

---

## 5. Supabase Realtime

The server never writes to Realtime itself; it writes tables, and Supabase
broadcasts. The site may subscribe with the **anon key**, which means RLS decides
what arrives. Policies exist for exactly these tables:

| Table                     | Policy                                     | Filter the site should use                        |
| ------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `markets`                 | public read                                | `match_id=eq.<matchId>`                           |
| `matches`                 | public read                                | `id=eq.<matchId>`, or unsubscribed status changes |
| `tournament_matches`      | public read                                | `tournament_id=eq.<tournamentId>`                 |
| `players`                 | public read                                | team and bot labels                               |
| `match_players`           | public read                                | `match_id=eq.<matchId>`                           |
| `bets`                    | own rows only                              | `user_id=eq.<own user id>`                        |
| `tournaments`             | public read                                | the list page                                     |
| `match_events`            | readable only once a match is **finished** | replay page                                       |
| `deposits`, `withdrawals` | own rows only                              | the wallet page                                   |
| `bot_publications`        | public read                                | bot history and published numbers                 |

Columns the site may rely on, from the migrations:

- `markets`: `id`, `match_id`, `market_type`, `subject`, `line`, `selection_key`,
  `status`, `fair_probability`, `odds_decimal`, `max_stake_minor`, `is_live`.
- `matches`: `id`, `game`, `status`, `seed_commit`, `seed_reveal`, `config`,
  `result`, `result_signature`, `log_head_hash`, `started_at`, `ended_at`.
- `tournament_matches`: `tournament_id`, `match_id`, `round`, `position`, `status`.
- `bets`: `id`, `user_id`, `market_id`, `stake_minor`, `odds_locked`, `status`,
  `potential_payout_minor`, `payout_minor`, `placed_at`, `settled_at`, `result`.

Anything not in that list is internal: `ledger_entries`, `account_balances`,
`audit_log`, `alerts`, `market_overrides`, `scheduler_leases`. Do not subscribe to
them even where a policy might let a single row through.

Market status is one of `open`, `suspended`, `closed`, `settled`, `void`. Note
`closed`: in-play markets are closed while the board moves and reopened two
seconds later, so `closed` on a live market is normal and not an error.

---

## 6. Money rules the UI must respect

**Integers only.** Every amount is a whole number of minor units (kobo in real
mode, coins in virtual mode). Never send a decimal, never format before sending.
100 minor units make one major unit.

**Currency comes from the server.** `GET /api/config` returns `currency` (`XTS`
while `moneyMode` is `virtual`, `NGN` in real mode) and `moneyMode`. Both come from
the process environment, and the same database keeps the two currencies in
separate accounts. The site must display the currency the config returns and must
not hardcode either code.

**Stakes.** `minStakeMinor` (default 100) comes from `/api/config`. The per-market
ceiling is that market's `maxStakeMinor`. A player's own ceiling is `maxStakeMinor`
in `/api/me/limits`, and may be lower than the market's.

**Odds drift.** Send `expectedOdds` with the price the player saw. If the price
moved past the tolerance the answer is `odds_moved`, and the site must show the new
price and ask again rather than silently filling at a different number.

**Exposure caps.** The book will not take more than `MATCH_EXPOSURE_PCT` (default
20%) of free bankroll on one match, and has a global cap. Refusals arrive as
`match_exposure_cap` and `global_exposure_cap`.

**Self-exclusion and limits.** `POST /api/me/self-exclude {hours}` blocks betting
and deposits immediately. Limits set with `PUT /api/me/limits` may take effect
after a pending period (`pending` in the response says which and when), and a
tightened limit cannot be loosened at once. While excluded, every betting call
answers `self_excluded`; the site should hide the betting UI and show the end date.

**Large payouts.** A win of `LARGE_PAYOUT_MINOR` (default 5,000,000) or more is
held: the bet moves to `pending_review` and pays only after an operator approves it
(`/api/admin/bets/:id/approve`). The site should say "under review", not "won", and
not promise a time.

**Deposits.** `POST /api/deposits {amountMinor, provider?}` answers `201` with
`redirectUrl` and `credited`. In virtual mode the deposit is credited directly and
`credited` is true; in real mode the site redirects to `redirectUrl` and waits for
the provider's webhook, so the balance appears later. Never credit the UI from the
request alone.

**Withdrawals.** `POST /api/withdrawals {amountMinor, destination?}` answers `201`
with a withdrawal in `requested`. An operator approves it and marks it paid; the
money leaves the available balance at request time, so show it under
`pendingWithdrawalMinor` from `/api/me/wallet`, not as available.

---

## 7. Market catalog

Market ids are stable strings. `GET /api/matches/:id/markets` returns them grouped
by `marketType`, each with `selections[]` of `{selectionKey, oddsDecimal, status}`.
`subject` names the person or board a market is about, `line` is the numeric line
where the type has one (`null` otherwise).

**Carrom (19 types):** `board_winner`, `match_winner`, `points_handicap`,
`boards_handicap`, `winning_margin`, `loser_score`, `exact_boards`,
`both_win_board`, `comeback_board_1`, `board1_match_winner`, `queen_board1`,
`queen_covered`, `queen_wins_board`, `queen_first4`, `first_coin`, `first_foul`,
`foul_board1`, `striker_pocket`, `whitewash`.

**Ludo (26 types):** `ludo_match_winner`, `ludo_finish_place`, `ludo_top_two`,
`ludo_head_to_head`, `ludo_first_out`, `ludo_first_home`, `ludo_winner_turns`,
`ludo_first_up`, `ludo_second_up`, `ludo_never_last`, `ludo_first_out_winner`,
`ludo_win_margin`, `ludo_total_turns`, `ludo_total_sixes`, `ludo_seat_sixes`,
`ludo_first_six`, `ludo_triple_six`, `ludo_total_captures`, `ludo_first_capture`,
`ludo_winner_captures`, `ludo_winner_never_captured`, `ludo_seat_captures`,
`ludo_rolls_to_first_capture`, `ludo_home_at_turn_60`, `ludo_turns_parity`,
`ludo_last_roll_six`.

A four-seat Ludo match prices **275 selections across 26 types**; that is the
number the pricer reports and the number the site should expect.

**Live versus pre-match.** `isLive` marks a market that is repriced while the match
runs. Pre-match prices are written once; live prices are suspended for 2 seconds
after each shot and repriced at most once a second, against 5,000 simulations per
reprice rather than the 100,000 a pre-match price gets. The site should treat
`status: "suspended"` as "temporarily no betting", never as closed, and must not
cache a live price longer than a couple of seconds.

**Seat to colour.** Ludo selections are keyed by colour in seat order: seat 1
`red`, seat 2 `green`, seat 3 `yellow`, seat 4 `blue`. Getting this wrong by one is
how a winning bet reads as a loss.

---

## 8. Fairness data to display

- `seed_commit` is published when the match is created, before play. Show it on the
  match page; it is the promise the server made before it knew the result.
- `seed_reveal` appears in `GET /api/matches/:id` only once the match is finished,
  and is `null` before that. After the match, show both and let anyone check the
  commit.
- `GET /api/matches/:id/replay` returns the whole log, the result, the result
  signature, the log head hash, and a `verification` block:
  `{chainOk: true, head: "<hash>", reason: null, seq: null}`. A replay page should
  render that block as-is: `chainOk` false means the log does not verify, and
  `reason` and `seq` say where it broke.
- Bot labels: `GET /api/bots` returns `displayName`, `level`, `policy` and the
  published numbers (aim error, selection quality, power error). These are the
  numbers the operator publishes, and `GET /api/admin/bots/:botId/history` is the
  audit trail behind them. A bot's published numbers are public on purpose, so a
  player can see the machine they are facing is fair.

---

## 9. Known limitations

- **The load test has not been run against the deployed host.** `npm run loadtest`
  and `npm run spectate:loadtest` were run locally against a loopback server:
  500 spectators delivered 100.000% of 20,000 owed frames with fan-out p95 of
  10.3 ms, and the public reads served 6,468 req/s with the rate limiter lifted,
  9,912 req/s with production limits on (answering 429). The deployed instance has
  not been measured from outside yet.
- **One instance, by design.** Room state, the matchmaker's room table and the
  spectator hub live in the process. Running two replicas would split them. If the
  site needs more capacity the answer is a bigger instance, not a second one.
- **Free-plan idling.** A sleeping instance means a cold start of up to a minute on
  the first request.
- **Markets are priced, not streamed.** New prices arrive by polling
  `GET /api/matches/:id/markets` or by Realtime on `markets`. There is no push
  channel for price changes over the game socket.
- **`match_events` is readable only after a match finishes**, so a live replay page
  cannot show the log mid-match.
- **No client for admin routes.** They are key-protected HTTP with no session, so
  an admin UI needs a server of your own holding the key.
- **The finishing order of a match that ends without a full board** (a forfeit by
  timeout) ranks the seats that did not finish by tokens home and then progress.
  That is a server decision, and the site should present it as a final placing
  rather than as a race result.

---

## 10. Checklist for the website developer

Environment variables the site needs, names only. Never commit the values.

| Name                            | Where it may live | Notes                                                    |
| ------------------------------- | ----------------- | -------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | browser           | the project URL                                          |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser           | safe **only** because RLS guards the data                |
| `NEXT_PUBLIC_API_BASE`          | browser           | `https://strikezone-server-ex45.onrender.com`            |
| `NEXT_PUBLIC_SOCKET_URL`        | browser           | `wss://strikezone-server-ex45.onrender.com`, bare origin |
| `SUPABASE_SERVICE_ROLE_KEY`     | server only       | **never** in the browser bundle                          |
| `ADMIN_API_KEY`                 | server only       | **never** in the browser bundle                          |

Must never reach the browser: `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_API_KEY`,
`RESULT_SIGNING_SECRET`, and any database connection string. The service role key
bypasses every RLS policy, so a leak is the whole database.

Before you ship:

1. Send the access token as `Authorization: Bearer …` on every `/api/me/*` call and
   as the Colyseus join option `{ token }`.
2. Join the socket with the bare origin, no path.
3. Decode stream frames through `src/api/contract.ts`, not by hand.
4. Read `currency` and `moneyMode` from `/api/config`; never hardcode `XTS` or
   `NGN` in the UI.
5. Send `expectedOdds` with every bet and handle `odds_moved` by re-asking.
6. Branch on the bet error codes in the table above, not on message text.
7. Show `seed_commit` before the match and `seed_reveal` plus the replay
   verification block after it.
8. Map Ludo seats to colours as red, green, yellow, blue in seat order 1 to 4.
9. Treat `pending_review` as "under review", not "won".
10. Show a waking-up state on the first request in case the instance idled.
