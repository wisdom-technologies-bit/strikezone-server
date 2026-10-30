# Load testing

`npm run loadtest -- --url http://localhost:2567 --seconds 20 --concurrency 50`

The script (`scripts/loadtest.ts`) measures two things that fail independently:

- **HTTP**: public read endpoints (`/health`, `/api/bots`, `/api/matches`,
  `/api/players`) driven by a fixed number of workers until a deadline. It reports
  requests per second and the p50, p95 and p99 latency over the real responses,
  plus the status mix. A 5xx or a transport error fails the run.
- **CPU**: games per second through the Ludo simulator on one core, which is what
  decides whether a price fits in its budget.

Run it against a **running server**, not in-process: a latency measured inside the
process that is being measured is not a latency. Locally:

```bash
npm run build && npm start &
npm run loadtest -- --seconds 20 --concurrency 50 --games 200
```

## The budgets this project is held to

| What                                                | Budget                       | Why                                                                                                                                      |
| --------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-match price, one match, one core set of threads | under 60 s                   | one million simulated games; the pricer measures throughput first and falls back to 200,000 games inside the budget, logging that it did |
| Live reprice after a roll                           | under 500 ms                 | 2,000 to 5,000 resumed games; the book is suspended for exactly this window                                                              |
| Public read p95                                     | under 150 ms at 200 req/s    | the site's pages and the spectator list                                                                                                  |
| Admin overview p95                                  | under 500 ms                 | it aggregates live exposure and solvency                                                                                                 |
| Ludo simulator                                      | over 20,000 games/s per core | 275 markets from one million games inside the minute                                                                                     |

The first two are not measured by this script: they are asserted by the test suite
(`tests/odds/ludo-pricer.test.ts` and `tests/odds/ludo-live.test.ts`), which fails
if the pricer overruns its budget, and measured per run in the price report's
`calibrationMs`, `simulatedGames` and `fellBack` fields.

## Reading the output

```
requests      10043 in 20.0s
throughput    502.1 req/s
latency p50   41.2 ms
latency p95   96.4 ms
latency p99   180.7 ms
statuses      200×10043
simulator     28,431 ludo games/s on one core
             0.035 ms per game
```

A p99 far above the p95 is a queue, not slow code: look at the worker count
relative to cores. Throughput that stops rising as concurrency rises is one
bottleneck; on this server it is almost always the database round trip in the
public read cache.

## Recorded runs

| When       | Host               | Configuration                  | Result                                   |
| ---------- | ------------------ | ------------------------------ | ---------------------------------------- |
| 2026-10-30 | development laptop | 50 workers, 20 s, local server | see the "Verified" section of the README |

Record every run against a deployed host here. A number nobody recorded is a
number nobody will notice degrading.
