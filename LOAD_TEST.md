# Load test

Two loads, measured separately because they fail separately: five hundred people
watching one match, and the public reads servers serve to everyone else. Every
number below is measured on one process, over loopback, on the development
build. Nothing here is extrapolated.

Reproduce with:

```sh
# the spectator stream: 500 sockets on one Ludo room
SPECTATOR_JOIN_PER_MINUTE=3000 npm run spectate:loadtest -- --spectators 500 --moves 40

# the public reads, against a running server
npm run loadtest -- --url http://localhost:2623 --concurrency 500 --seconds 15
```

## 500 spectators, one match

`scripts/spectate-loadtest.ts` boots the real `LudoRoom` over a real WebSocket
server, plays a four-bot match, and joins five hundred spectators in batches of
fifty. It records what each spectator received, and judges three things: whether
every viewer got in, whether every frame it was owed arrived, and whether the
frames arrived in order.

| Measure | Result |
| --- | --- |
| Spectators connected | 500 of 500, 0 failures |
| Join, all 500 | 1.49 s |
| Join p50 / p95 / p99 / max | 109 / 160 / 174 / 178 ms |
| Broadcasts measured | 40 (20,000 owed frames) |
| Delivered | 100.000%, 0 gaps |
| Out of order | 0 |
| Frames skipped for slow sockets | 0 |
| Fan-out p50 / p95 / max | 8.8 / 10.3 / 13.8 ms |
| Resident memory | 257 MB idle, 405 MB with 500 sockets |

Fan-out is the gap between the first and the last spectator to receive the same
broadcast: about nine milliseconds to reach five hundred people, thirteen at the
tail. A frame a viewer misses because its socket is behind is skipped on purpose
by the hub, which then tells that viewer how much it missed; the harness counts
those separately and found none at this size.

Two conditions the harness has to respect or it measures the wrong thing. Joins
from one address are rate limited to `SPECTATOR_JOIN_PER_MINUTE` (60 a minute by
default), and the room's per-viewer buffer cap skips frames for a socket that is
behind. Five hundred sockets from one machine is therefore a raised join limit,
deliberately, with `MAX_SPECTATORS_PER_ROOM` left at its production 2,000. And
the run only starts counting once the join window has closed, because a viewer
that has not received its snapshot yet is held back on purpose, and scoring that
window as loss measures the handshake.

## The public reads

`scripts/loadtest.ts` hammers four endpoints that all answer 200 on a healthy
server: `/health`, `/api/bots`, `/api/tournaments`, `/api/leaderboard`. The
earlier path list included a route that does not exist, which turned half the
sample into 404s and flattered the throughput; that is fixed.

Five hundred concurrent workers, fifteen seconds, rate limiting lifted:

| Measure | Result |
| --- | --- |
| Requests | 97,634 in 15.1 s |
| Throughput | 6,468 req/s |
| p50 | 53.7 ms |
| p95 | 115.5 ms |
| p99 | 788.3 ms |
| Statuses | 200 × 97,634 |

The same run with production rate limits left on answers almost everything with
429: 149,483 requests in 15.1 s, 9,912 req/s, p50 48 ms, p95 83 ms, p99 104 ms.
That is the limiter doing its job, and it is the number that matters for a
launch, because at 500 workers from one address the correct answer is a refusal.
The ceiling above it is what one process can serve when the refusal is removed.

## The simulator

Pricing a match is a simulation, so its speed is a launch number too.

| Measure | Result |
| --- | --- |
| Ludo games per second, one core | 4,296 |
| Milliseconds per game | 0.233 |

275 Ludo selections at 20,000 games therefore costs about five seconds on one
core, which is why the live pricer runs on a worker pool with a budget rather
than inside the request.

## What this does not measure

- One process, one machine, loopback. Render adds network, a shared CPU, and a
  cold start; the free instance also sleeps.
- The development build (`tsx`), not the compiled image.
- One room. Several concurrent matches multiply the fan-out; the per-room cap
  and the join limiter are per room and per address.
