# Carrom rules

What this engine implements, what I learned from the reference simulator, and
everywhere the rules are ambiguous, with the interpretation I chose and the
questions I could not settle.

The implementation lives in `src/engines/carrom`. All of it is original code.

## 1. The reference, and what I took from it

Reference read: `samiranrl/Carrom_rl`, a Python simulator (pygame + pymunk,
GPL v3). I read the README, the shared `Utils.py` and the single-player server
module. **No code was copied, translated or paraphrased.** The GPL code was used
only to understand conventions, and everything below is written from the rules of
carrom and from my own design.

What I learned from it:

- **What it is.** A learning environment for carrom: a physics board plus a
  socket server that hands an agent the state and receives one shot at a time.
  There is a single-player variant (clear the board, any coin scores) and a
  two-player variant where each side owns a colour. Its single-player rules are
  deliberately simplified, so I did not adopt them; I implemented the
  International Carrom Federation (ICF) singles rules the brief asked for.
- **Board geometry.** A square playing area with a wall around it and a pocket
  cut into each of the four corners, set in from both adjoining walls rather than
  sitting exactly on the corner. In its coordinate system the board is a square
  with the origin at one corner, x to the right and y downwards, and the pockets
  near the four corners.
- **Piece sizes relative to the board.** The coin is the smallest body, the
  striker noticeably larger, and each pocket only slightly wider than a coin, so
  a coin must arrive reasonably square to drop. Its constants put the coin radius
  at roughly 1/53 of the board side, the striker radius around 1/39, and the
  pocket radius around 1/36. My defaults (31 mm coin, 41 mm striker, 45 mm pocket
  on a 740 mm board) sit in the same proportions, as the brief specified.
- **Coin and striker setup.** Nineteen pieces: nine white, nine black, one queen,
  arranged as a hexagonal cluster around the centre, with the queen at the centre
  and the two colours alternating outward. The striker is not part of that
  cluster: it is placed on a line near the shooting player's edge of the board,
  and the two players shoot from opposite edges.
- **How an agent supplies a shot.** Three numbers, none of them a velocity: a
  position along the baseline, an angle, and a force. The position is normalised
  across the legal part of the baseline, the angle is in degrees, and the force
  is normalised so that maximum force is calibrated by a stated travel distance
  rather than by physical units. Illegal values are replaced by random legal ones
  and small noise is added to every shot, which is a property of that
  environment, not of carrom.
- **Rule handling worth noting.** It tracks the queen as a special case: the
  queen may not be taken before one of your own coins, an uncovered queen must be
  covered on the next stroke or returns to the centre, and pocketing the striker
  is a foul that returns the coins pocketed during that stroke and ends the turn.
  That matches ICF in spirit, so I implemented the same behaviour with my own
  rules engine.

Where I deliberately diverged: coordinates in millimetres with the origin at the
**centre** of the board (y up), angles in radians, power as a fraction of a
configured maximum speed, no random noise in the shot, no randomisation of
illegal input (an illegal shot is an error, not a re-roll), and a fully custom
circle physics step instead of a third-party engine.

## 2. Equipment and layout

- Playing area: a square, 740 mm by 740 mm, with walls on all four sides.
- Four corner pockets, 45 mm in diameter, set into the corners.
- Nineteen pieces: 9 white coins, 9 black coins, 1 queen (red). Coins are 31 mm
  in diameter and about 5 g; the striker is 41 mm and about 15 g.
- Starting layout: the queen at the centre, a ring of six coins around it, and a
  ring of twelve outside that, colours alternating in both rings (3 white and 3
  black inside, 6 and 6 outside, which accounts for all 18 coins). Each ring sits
  at a distance of one coin diameter from the next, so the coins touch without
  overlapping.
- Both players shoot from their own side: white (player 1) from the near edge,
  black (player 2) from the far edge. The striker is placed on that side's
  baseline, between the corner circles, and flicked along the board.

## 3. Rules implemented (ICF-style singles)

**The shot.** A shot is a striker position on the shooter's baseline, an angle,
and a power from 0 to 1. The striker may not be placed overlapping a coin, and
may not be placed outside the legal part of the baseline.

**Turn.** White breaks. A player continues their turn after pocketing one of
their own coins. Pocketing nothing, or committing a foul, ends the turn.

**The queen.** A player may pocket the queen only after pocketing at least one of
their own coins; a queen pocketed earlier than that returns to the centre and is
not a foul. Pocketing the queen obliges the player to cover it by pocketing one
of their own coins in the same turn; pocketing a coin in the same stroke also
covers it. A covered queen is worth 3 points to whoever covered it. An uncovered
queen returns to the centre.

**Fouls.** Pocketing the striker, or pocketing an opponent's coin. The penalty is
one of the offender's already-pocketed coins returning to the centre, or, if they
have none, a debt of one coin that is settled with the next coin they pocket. A
foul ends the turn.

**Ending a board.** A board ends when a player has pocketed all nine of their own
coins and the queen has been resolved. The winner scores 1 point for each of the
opponent's coins still on the board, plus 3 if the winner covered the queen.

**Ending a match.** First to 25 points, or the higher score after 8 boards. Both
limits are configurable. Equal scores after the last board are a draw.

## 4. Physics

- Custom circle physics, no third-party engine: equal-and-opposite impulses along
  the contact normal, with a coefficient of restitution, plus a positional
  correction so bodies never remain overlapping.
- Fixed timestep of 1/240 s. Every step: apply rolling friction, integrate,
  capture pockets, resolve walls, resolve every pair of bodies (repeated while
  contacts remain, at most twice, so a cluster of coins settles within one step
  rather than smearing over several), then clamp to the walls again. Pairs where
  neither body is moving are skipped, and a pass with no contact ends the
  repetition early, which is what keeps a twenty-shot board under the 20 ms
  budget.
- Rolling friction is a constant deceleration; a body whose speed falls below a
  threshold stops exactly, so a shot always terminates.
- A body is pocketed when its centre comes within the pocket radius of a pocket
  centre. Pocket capture is checked before wall bounces, so a coin entering a
  pocket cannot bounce out of it.
- Determinism: no random numbers, no time or environment input, arrays iterated in
  a fixed order, and a fixed number of steps per second. The optimisations above
  only skip work that cannot change the result. Given the same state,
  shot and config the result is identical, and the tests assert that.

## 5. Conventions

- Units: millimetres, grams, seconds.
- Origin at the centre of the board, x to the right, y up. The playing area
  spans -370 to +370 on both axes, with bodies clamped a radius inside the walls.
- Angle: radians, 0 pointing along +x, increasing anticlockwise, so +pi/2 is
  straight up the board.
- The near baseline (white) is at y = -(half - baselineOffset); the far baseline
  (black) is mirrored.
- Ids are stable: `striker`, `queen`, `w1`..`w9`, `b1`..`b9`. A coin that returns
  to the board keeps its id, so a spectator can follow it.

## 6. Decisions I had to make (for review)

1. **The queen may only be taken after one of your own coins.** ICF requires it.
   A queen pocketed earlier is returned to the centre, and it is not a foul.
2. **Pocketing the queen grants one extra stroke to cover it,** even though the
   brief said only "on the same turn". Without the extra stroke a cover would be
   impossible unless the coin dropped in the same shot, which is not how carrom is
   played.
3. **Covering in the same stroke as the queen counts,** and is reported as both
   `queen_pocketed` and `queen_covered`.
4. **A foul cancels the coins pocketed in that stroke.** They go back to the
   centre, so a fouling stroke scores nothing. This is the reference's behaviour
   and common house practice.
5. **An opponent's coin pocketed on a fouling stroke stays pocketed and counts
   for the opponent.** It is not returned: only the offender loses the turn and
   pays the penalty. Some house rules return it instead.
6. **A debt is settled by the next coin the offender pockets:** that coin goes to
   the centre instead of staying pocketed, and the debt drops by one. The stroke
   still counts as pocketing an own coin for the purpose of keeping the turn.
7. **A player who pockets their own last coin while the queen is still on the
   board ends the board and scores no queen bonus.** ICF would award the queen to
   the opponent in some readings; the brief does not mention it, so I did not
   invent it.
8. **The breaker alternates every board.** White breaks the first board, then the
   other player breaks the next.
9. **Two baselines, one per player, on opposite edges.** ICF boards carry base
   lines on all four sides; singles only ever uses two of them, so I modelled the
   two.
10. **An illegal striker placement is an error, not a re-roll.** `applyShot`
    throws with a message the caller can act on, and `getLegalStrikerRange` plus
    `findLegalStrikerX` exist so callers place legally. The brief's own list of
    shot fields has no notion of a rejected shot, so this keeps the engine
    honest rather than silently moving the striker.
11. **Pocket capture is centre-within-pocket-radius,** as the brief specified.
    Real pockets are cut into the corner, so a coin hugging a wall can pass the
    mouth of a pocket without dropping; this model reproduces that.
12. **Power 0 is a legal shot** that moves nothing and passes the turn. It is
    useful as a deliberate pass and keeps the physics simple.
13. **A stopped shot has a hard time limit** (`maxShotSeconds`, default 3 s). If
    anything is still moving at the limit, all motion is discarded and the shot
    is resolved as if everything had come to rest.
14. **The queen's return spot is the nearest free position to the centre,** found
    by scanning a fixed spiral, not a random one, so the result stays
    deterministic.
15. **The initial layout is fixed by the rules,** so the seed does not change it.
    The seed is stored in the state so that the fair-play commit and any future
    random element (bot choice, variant layouts) can be derived from it.

## 7. Rules I am still unsure about

1. **Opponent's coin on a foul:** stays pocketed and scores for them (my choice),
   or returns to the centre?
2. **Foul scope:** does a foul cancel only the stroke's coins, or every coin
   pocketed during the whole turn?
3. **Queen cover timing:** should pocketing the queen alone really grant an extra
   stroke, or must it be covered in the same stroke?
4. **Unresolved queen:** if a player clears their last coin while the queen is
   still on the board, does the queen go to the opponent, stay, or is the board
   void? I score no queen bonus and end the board.
5. **Penalty destination:** the centre spot, or the offender's baseline?
6. **Debt settlement:** my "next coin goes back" rule, or pay at the end of the
   turn, or immediately if a coin is available later in the board?
7. **Striker touching a coin:** I reject overlap, but real rules also forbid
   placing the striker touching a coin. Should the engine enforce a clearance
   (`strikerClearanceMm` exists in the config but defaults to 0)?
8. **Baseline geometry:** the exact ICF distance from the frame to the base lines,
   and whether the striker may overhang the line. My defaults are
   `baselineOffsetMm = 90` and a legal x range inset 120 mm from each side wall.
9. **Dead coin at the baseline:** if a resting coin blocks a large part of the
   baseline, may the player still place the striker as close as possible on
   either side? I only reject overlap, so yes.
10. **Queen "due" and the board end:** should a pocketed but uncovered queen block
    the board from ending? It cannot arise in my flow, because the extra stroke
    resolves the queen first, but the rule should be confirmed.
11. **Scoring the loser:** should the losing player also score for their own
    covered queen when the board ends? I award the queen bonus only to the winner.
12. **Match tie-break:** after 8 boards with equal scores I report a draw. ICF
    competitions usually play a tie-break board.
