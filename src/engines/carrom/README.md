# src/engines/carrom

Carrom rules engine: board geometry, striker aim and impulse resolution, coin
and pocket state, turn and foul handling, and the win condition for a singles or
doubles match.

Constraints from AI_RULES.md: pure code only (no network or database imports),
randomness injected from `src/lib/fair-rng.ts`, no access to bets or stakes, and
a header comment naming any reference that informed the rules or geometry while
stating the code is original.
