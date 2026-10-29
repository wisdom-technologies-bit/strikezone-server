# src/odds

Odds model and the simulator that calibrates it.

This is where the house margin (`HOUSE_MARGIN_BPS`, 600 = 6.00%) is applied. The
simulator reuses the pure engines from `src/engines` to estimate outcome
probabilities without a network or a database.

`src/odds` is one of only two places allowed to read betting data
(AI_RULES.md hard rule 4).
