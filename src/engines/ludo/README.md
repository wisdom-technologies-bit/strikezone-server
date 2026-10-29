# src/engines/ludo

Ludo rules engine: board topology, dice handling, legal move enumeration, token
capture, safe squares and the finishing condition.

Same constraints as every engine: pure code with no I/O, seeded randomness
injected from `src/lib/fair-rng.ts`, no betting data, and a reference comment on
any file informed by an external rules implementation.
