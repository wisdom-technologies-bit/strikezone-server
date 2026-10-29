# src/admin

Admin operations: match and bet inspection, manual adjustments, user sanctions
and support tooling.

Admin HTTP routes authenticate with `ADMIN_API_KEY` from `src/lib/env.ts`; the
key is compared in constant time and never logged. Admin actions that move money
call `src/wallet`, and every admin action is written to an audit trail.
