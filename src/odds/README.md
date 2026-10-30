# src/odds

Odds model and the simulator that calibrates it.

This is where the house margin (`HOUSE_MARGIN_BPS`, 600 = 6.00%) is applied. The
simulator reuses the pure engines from `src/engines` to estimate outcome
probabilities without a network or a database.

`src/odds` is one of only two places allowed to read betting data
(AI_RULES.md hard rule 4).

## What is here now

| File                   | What it does                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| `shot-table.ts`        | Loads and reads the calibrated pot-chance grid.                           |
| `calibrate.ts`         | Measures that grid with the real engine (2000 shots per cell).            |
| `data/shot-table.json` | The committed calibration, plus a typed module the code imports.          |
| `skill.ts`             | Bots as published; humans shrunk towards Club over their last 30 matches. |
| `stats.ts`             | `MatchStats`: everything a market settles against, from the event log.    |
| `carrom-fast-model.ts` | A whole match without physics, seeded and reproducible.                   |

`npm run odds:calibrate` regenerates the table. It takes about five seconds.

## Known defects, deliberately recorded

1. **The shot table is not monotone cell by cell.** Shots that cannot be played
   from a legal baseline leave cells empty, and those cells are filled from their
   neighbours, so an easier cell can carry a harder cell's number. The table is
   only claimed in aggregate: about 16% for a six degree aim error, about 31% for
   the best hands, and clamped at 0.75.
2. **The fast model is too confident about skill.** A Club bot beats a Rookie
   about 97 times in 100, and a Master is indistinguishable from Club at that
   point. The real distribution is certainly closer. This needs the
   fast-versus-real harness (2000 engine matches per pairing) before any of it
   prices money; until then, treat the probabilities as shape, not truth.
3. **Still missing:** the 28 market types and their settlement rules, the pricer,
   live repricing, `GET /api/matches/:id/markets`, and the backtest. Nothing in
   this directory writes to the markets table yet.
