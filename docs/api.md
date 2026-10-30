# The API, as the website sees it

Everything here is public and versioned with `src/api/contract.ts`. That file is
the source of truth: it holds every request and response schema, the stream
messages and the frame decoder, and it imports nothing but zod, so the website
repository can copy it as it is and compile it on its own
(`npm run contract:check`).

Base URL: `https://<host>`. All bodies are JSON. Money is always an integer in
minor units (kobo). Timestamps are ISO 8601 UTC.

Errors use one envelope, on every route:

```json
{ "ok": false, "error": "invalid_request", "issues": [{ "path": "limit", "message": "Too big" }] }
```

## Caching and rate limiting

Every public `GET` is cached for **2 seconds** per URL in the server process and
carries `Cache-Control: public, max-age=2`. A cached response has the header
`x-cache: hit`; a fresh one has `x-cache: miss`.

Every public request is limited to **120 requests per minute per IP** (default,
configurable). Over the limit:

```json
{ "ok": false, "error": "rate_limited" }
```

with a `Retry-After` header in seconds. `/api/admin/*` and `/dev/*` are exempt
from both.

## Public reads

### `GET /api/config`

Currency, money mode and the limits the site has to display.

```json
{
  "ok": true,
  "currency": "NGN",
  "moneyMode": "virtual",
  "minStakeMinor": 100,
  "maxStakeMinor": 5000000,
  "houseMarginBps": 600,
  "limits": {
    "minStakeMinor": 100,
    "maxStakeMinor": 5000000,
    "matchExposurePct": 20,
    "largePayoutMinor": 5000000,
    "betRateLimitPerMinute": 10,
    "minAccountAgeHours": 24
  },
  "contractVersion": 1,
  "depositsEnabled": true
}
```

### `GET /api/matches/live`, `/api/matches/upcoming`, `/api/matches/recent`

`live` is started and unfinished, `upcoming` is scheduled, `recent` is finished
or void, newest first. Query: `limit` (1-100, default 20), `cursor`, and optional
`game=carrom|ludo`, `tournamentId`.

```json
{
  "ok": true,
  "matches": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "game": "carrom",
      "status": "live",
      "tournamentId": null,
      "isTournament": false,
      "startedAt": "2026-10-30T10:00:00.000Z",
      "endedAt": null,
      "players": [
        {
          "seat": 1,
          "playerId": null,
          "displayName": "Master Bot",
          "isBot": true,
          "botLevel": "master",
          "score": 12
        },
        {
          "seat": 2,
          "playerId": null,
          "displayName": "Club Bot",
          "isBot": true,
          "botLevel": "club",
          "score": 8
        }
      ],
      "scores": { "white": 12, "black": 8 },
      "roomId": "11111111-1111-4111-8111-111111111111"
    }
  ],
  "nextCursor": null
}
```

`roomId` is what a spectator passes to the Colyseus client. It is the match id,
and it is only set while the match is live.

### `GET /api/matches/:id`

The same fields, plus the commitment and the result:

```json
{
  "ok": true,
  "match": {
    "id": "11111111-1111-4111-8111-111111111111",
    "game": "carrom",
    "status": "finished",
    "players": [{ "seat": 1, "displayName": "Ada", "isBot": false }],
    "scores": { "white": 25, "black": 11 },
    "roomId": null,
    "seedCommit": "abababababababababababababababababababababababababababababababab",
    "seedReveal": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    "resultSignature": "efefef...",
    "logHeadHash": "121212...",
    "result": { "winner": "white" }
  }
}
```

`seedReveal` is `null` until the match is finished: while it is live only
`seedCommit` is public.

`GET /api/matches/:id/replay` (from the match log) and
`GET /api/matches/:id/markets` (from the odds catalog) sit alongside it.

### `GET /api/players/:id`

```json
{
  "ok": true,
  "player": {
    "id": "22222222-2222-4222-8222-222222222222",
    "displayName": "Ada",
    "isBot": false,
    "botLevel": null,
    "rating": 1200,
    "played": 3,
    "won": 2,
    "lost": 1,
    "recentResults": [
      {
        "matchId": "11111111-1111-4111-8111-111111111111",
        "opponent": "Club Bot",
        "result": "won",
        "score": "25-11",
        "endedAt": "2026-10-30T10:20:00.000Z"
      }
    ]
  }
}
```

### `GET /api/leaderboard`

Query: `limit` (1-100, default 25), `bots=include|exclude|only`.

```json
{
  "ok": true,
  "entries": [
    {
      "rank": 1,
      "playerId": "22222222-2222-4222-8222-222222222222",
      "displayName": "Ada",
      "isBot": false,
      "rating": 1200,
      "played": 3,
      "won": 2
    }
  ]
}
```

### `GET /api/tournaments`, `GET /api/tournaments/:id`

Served by the tournament module (see `src/tournaments/README.md`); both are on the
same cache and limit as the rest.

## The signed-in player

`Authorization: Bearer <supabase-access-token>` on every route below. The token is
checked against Supabase; a missing one is `401 missing_token` and a bad one is
`401 invalid_token`. **These routes are never cached and never shared.**

### `GET /api/me/wallet`

```json
{
  "ok": true,
  "currency": "NGN",
  "availableMinor": 25000,
  "atRiskMinor": 1000,
  "pendingWithdrawalMinor": 0,
  "totalBalanceMinor": 26000
}
```

### `GET /api/me/transactions`

Query: `limit` (1-100, default 20), `cursor`.

```json
{
  "ok": true,
  "currency": "NGN",
  "transactions": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "kind": "bet_stake",
      "refType": "bet",
      "refId": null,
      "amountMinor": -1000,
      "balanceAfterMinor": 25000,
      "createdAt": "2026-10-30T09:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /api/me/bets`

Served by the betting module, same auth rule.

## The spectator stream

Join over the Colyseus client:

```js
import { Client } from "colyseus.js";

const client = new Client("wss://<host>/colyseus");
const room = await client.joinById(matchId, { spectate: true }); // no token needed
room.onMessage("*", (type, payload) => {
  /* see below */
});
```

A spectator receives, in this order:

1. `welcome` - once, on join.
2. `snapshot` - once, the full state. A viewer that joins mid-shot gets this
   _after_ that shot completes, and is sent no frames before it.
3. `shot` - once per shot, in order, with the recording.
4. `match_end` - once, when the match is over.

Optional at any time: `lag` (frames were skipped because the socket was behind;
a fresh `snapshot` follows) and `rejected` (something you sent was refused; a
spectator may not send shots at all).

### `welcome`

```json
{ "type": "welcome", "matchId": "1111...", "spectate": true, "spectators": 41, "fps": 30 }
```

### `snapshot`

```json
{
  "type": "snapshot",
  "matchId": "1111...",
  "status": "live",
  "board": 1,
  "turn": "white",
  "turnSeat": 1,
  "phase": "aiming",
  "shotNumber": 12,
  "turnEndsAt": 1793361600000,
  "queenOnBoard": true,
  "queenPendingSeat": 0,
  "scores": { "white": 12, "black": 8 },
  "seats": [
    {
      "seat": 1,
      "playerId": null,
      "displayName": "Master Bot",
      "isBot": true,
      "botLevel": "master",
      "score": 12,
      "connected": true
    }
  ],
  "coins": [{ "id": "white-1", "colour": "white", "x": 120.5, "y": 300.25 }],
  "seedCommit": "ababab..."
}
```

### `shot`

```json
{
  "type": "shot",
  "shotNumber": 13,
  "seat": 1,
  "events": [
    { "type": "coin_pocketed", "shot": 13, "coin": "white", "creditedTo": "white", "by": "white" }
  ],
  "frames": {
    "fps": 30,
    "bodyIds": ["white-1", "black-1", "queen", "striker"],
    "frameCount": 42,
    "data": "AABkAQB4AA..."
  },
  "nextState": {
    "board": 1,
    "turn": "black",
    "phase": "aiming",
    "shotNumber": 13,
    "scores": { "white": 13, "black": 8 },
    "queue": [{ "id": "white-1", "colour": "white", "x": 130, "y": 320 }]
  }
}
```

`events` is the referee's own list (pocketed coins, fouls, turn ends);

`frames` is the recording, quantised:

- `bodyIds` is the header: the bodies in the order their positions appear.
- `data` is base64 of `frameCount × bodyIds.length × 2` **unsigned 16-bit**
  values, `x` then `y` for each body, in header order.
- decoding one value, in millimetres: `x = value / 65535 * 740`.

```js
import { decodeFrames, frameBodies, positionAt } from "./contract.ts";

const decoded = decodeFrames(message.frames);
const bodies = frameBodies(decoded, 10); // every body in frame 10
const striker = positionAt(decoded, 10, "striker");
```

The precision is 0.0113 mm, far under a coin's 15.5 mm radius, and a full four
body frame costs 16 bytes before base64.

### `match_end`

```json
{
  "type": "end",
  "matchId": "1111...",
  "winner": "white",
  "reason": "scored",
  "scores": { "white": 25, "black": 11 },
  "seedReveal": "cdcdcd...",
  "resultSignature": "efefef..."
}
```

On the wire the message name is `match_end` (`STREAM_MESSAGES.end`); the `type`
inside is `end`.

### `lag`

```json
{ "type": "lag", "skippedShots": 3, "reason": "slow_consumer" }
```

Sent when the server skipped frames for this viewer because its socket buffer was
over the cap. A `snapshot` follows, so a client should resynchronise rather than
try to catch up.

## Supabase Realtime

The website subscribes to these tables for live odds, scores and the player's own
money. Row level security already limits what an anonymous or signed-in session
can read; the service role is never used in the browser.

| Table                | What to subscribe to                                                        | Why                                                           |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `markets`            | `postgres_changes` on `UPDATE` and `INSERT`, filtered by `match_id`         | odds moved, a market suspended, a market settled              |
| `matches`            | `postgres_changes` on `UPDATE`, filtered by `id`                            | the score, the status, and `seed_reveal` appearing at the end |
| `tournament_matches` | `postgres_changes` on `UPDATE`, filtered by `tournament_id`                 | a bracket slot filled, a match advanced                       |
| `bets`               | `postgres_changes` on `INSERT`/`UPDATE`, filtered by `user_id = auth.uid()` | the player's own bets, including a payout held for review     |

```js
supabase
  .channel(`markets:${matchId}`)
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "markets", filter: `match_id=eq.${matchId}` },
    (payload) => {
      renderMarket(payload.new);
    },
  )
  .subscribe();
```

## Development viewer

With `NODE_ENV=development`, `GET /dev/watch.html` serves a page that starts a bot
match and draws the stream on a canvas. It exists to eyeball the stream, not to
ship.
