# src/tournaments

Tournament structure and progression: brackets, round scheduling, entry rules,
seeding and how a finished match advances a player.

Tournaments orchestrate rooms and read results; they do not implement game rules
and do not move money themselves. Any payout goes through `src/wallet`.
