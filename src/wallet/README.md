# src/wallet

The wallet ledger, and the only module allowed to change a balance.

Rules from AI_RULES.md hard rule 2:

- Amounts are integers in the smallest unit (kobo for NGN, coins for virtual
  play). Never floating point.
- Every credit and debit is a ledger entry with a reason and an idempotency key,
  written through this module. Deposits, stakes, payouts, bonuses and
  adjustments all come through here, never through direct balance updates.
- Balances are derived from the ledger, so a balance can always be audited.
