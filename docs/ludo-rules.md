# Ludo: the rules this engine implements

Written before the code, so the engine can be read against it. Every default below
is a field of `LudoConfig` in `src/engines/ludo/config.ts` and can be changed
per match without touching the engine. Ambiguous points are collected at the end
for a decision.

## 1. The board

The board is the classic cross: a 52-cell outer ring, four yards, four home
columns of six cells, and a centre.

- **Ring**: 52 cells, numbered 0 to 51 anticlockwise from the first player's
  starting cell.
- **Yards**: one per player, holding that player's tokens before they enter play.
  A token in the yard is not on the board and cannot be captured.
- **Starting cells** (the cell a token lands on when it leaves the yard) are 13
  cells apart: 0, 13, 26 and 39.
- **Safe cells** are the four starting cells plus the four star cells eight steps
  after each: 8, 21, 34 and 47. A token on a safe cell can never be captured.
- **Home columns**: each player's own six cells, entered after a full lap.
- **Home**: the centre. A token that reaches it is finished and leaves the board.

Players sit at the same four positions. In a two player match the two players sit
opposite each other and use starting cells 0 and 26; the other two seats are
empty. In a four player match all four seats are used, starting at 0, 13, 26, 39.

## 2. Progress

Each token's position is one number, its **progress**:

| Progress     | Meaning                           |
| ------------ | --------------------------------- |
| `-1`         | in the yard                       |
| `0`          | on its own starting cell          |
| `0` to `50`  | on the ring, `51` cells in all    |
| `51` to `56` | in its own home column, six cells |
| `57`         | home, finished                    |

Ring cell for a token at progress `p` on seat `s` is `(start(s) + p) mod 52`. So
progress counts steps taken since leaving the yard, which makes capture, safety
and the finish condition all integer arithmetic and keeps the engine allocation
free (see the benchmark in `npm run ludo:bench`).

## 3. A turn

1. The player rolls one six-sided die.
2. If the roll has no legal move, the turn passes.
3. Otherwise the player chooses one of their legal moves and it is applied.
4. The turn passes to the next player, unless the roll earned another one.

### Leaving the yard

A token leaves the yard only on a **6**, landing on its starting cell at progress 0. That is the whole move: the 6 is spent bringing the token out, and the token
does not then advance six cells. If every token is in the yard, a roll of 6 is the
only move available and the only legal moves are the yard tokens.

### Extra roll on a 6

A 6 grants another roll to the same player, after the move is applied.

### Three sixes

Three sixes in a row by the same player in the same turn forfeit that turn. The
third 6 is not played: the turn passes immediately. Two sixes followed by a
different number resets the count, and so does the start of a new turn.

## 4. Capturing

A token that lands on a cell occupied by exactly one opponent token, on a cell
that is not safe, sends that token back to its yard. That is a capture.

- Safe cells (starts and stars) cannot be captured on, by anyone.
- A capture does not on its own pass the turn: in the default configuration it
  earns another roll (see the ambiguities).
- Two or more tokens of the same colour on one cell form a **block**. A block
  cannot be captured, and in the default configuration an opponent cannot land on
  it at all, so the move is not legal. If the setting is turned off, an opponent
  may land on the block and captures every token on it.

## 5. The home column and finishing

After a full lap a token enters its own home column and no longer moves on the
ring. Inside the column a token needs an **exact** roll to reach home: a roll that
would take it past progress 57 is not a legal move for that token. A token that
reaches home is finished, leaves the board, and cannot be captured or moved again.

## 6. Ending

The first player to bring all four tokens home wins. Play then continues for the
remaining places: the next player to finish all four tokens is second, and so on.
Because every remaining token can always be brought home eventually, the game
always ends; the engine records the finishing order as it happens. When one
player is left it takes the last place and the game ends.

## 7. Where the randomness comes from

Every roll is drawn from the seeded generator in `src/lib/fair-rng.ts` with an
incrementing nonce, so a whole game can be recomputed from the revealed seed. The
die value is `1 + floor(u * 6)` for a uniform `u` in [0, 1), which is fair to
within 2^-48.

## 8. Ambiguities to decide

These are the points where published Ludo rules disagree, or where the brief did
not say. Each is implemented as written above, with a config switch, and each is
worth a decision before real money rides on a market priced from it.

1. **Extra roll on capture.** Default: yes. Some house rules give none.
   Switch: `extraRollOnCapture`.
2. **Extra roll on reaching home.** Default: yes, matching the common digital
   game. Switch: `extraRollOnHome`.
3. **Blocks.** Default: two or more of one colour block the cell completely, so an
   opponent may not land on it. Alternative: only capture is blocked.
   Switch: `stacking: "block" | "open"`.
4. **A 6 with no legal move.** Default: the turn passes, and the extra roll is
   lost with it. Alternative: the player rolls again. Switch: not implemented,
   because a 6 with no legal move can only happen when every token is home or
   blocked, and then another roll changes nothing.
5. **Three sixes and the move.** Default: the third 6 is not played. Alternative:
   play the third 6 and then forfeit. Switch: none.
6. **Passing a block.** Default: a token may pass through a blocked cell on its
   way, since only landing matters. Some rules forbid passing. Switch: none.
7. **Two player seating.** Default: opposite seats, starting cells 0 and 26.
   Alternative: adjacent seats, 0 and 13.
8. **Places after first.** Default: play continues and every place is decided.
   This is per the brief; a single-winner game would end at the first finish.
9. **Turn on finishing.** Default: finishing a token can earn another roll (see
   point 2); finishing your fourth token ends your involvement but not the game.
10. **Yard entry.** Default: a token brought out on a 6 lands on its own starting
    cell, which is a safe cell, so it cannot be captured immediately.
