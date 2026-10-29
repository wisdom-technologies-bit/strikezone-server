# src/betting

Bets, markets and liability.

Accepts bets, prices them against `src/odds`, tracks open exposure and resolves
each bet from the signed match result. Together with `src/odds`, the only place
allowed to read betting data (AI_RULES.md hard rule 4).

Money never moves here directly: every balance change is a wallet ledger entry
in `src/wallet` with integer amounts in the smallest unit (hard rule 2).
