/**
 * The geometry of the development Ludo board.
 *
 * Kept out of the page so it can be tested: a viewer that puts a token in the wrong
 * place is worse than no viewer, and this is the only part of the page with
 * arithmetic in it. Everything is in canvas pixels for a square board of `size`.
 *
 * The board is a schematic, not a licensed one: a square ring of 13 cells a side
 * (52 in all, matching the engine), a six-cell lane from each corner to the middle,
 * and a yard in each corner. The engine's own geometry is what decides the game;
 * this only draws the progress numbers it reports.
 */

export const SAFE_CELLS = [0, 8, 13, 21, 26, 34, 39, 47];
export const RING_CELLS = 52;
export const CELLS_PER_SIDE = 13;
export const PROGRESS_ON_RING = 50;
export const PROGRESS_LANE_START = 51;
export const PROGRESS_HOME = 57;

/**
 * The 52 ring positions, clockwise from the top left corner.
 *
 * Four sides of thirteen: each side starts at its corner and stops one cell short
 * of the next, so every cell is counted once and seat `n` starts at index `13n`.
 */
export function buildRing(size = 620, margin = 24) {
  const step = (size - margin * 2) / CELLS_PER_SIDE;
  const far = size - margin;
  const cells = [];

  for (let index = 0; index < CELLS_PER_SIDE; index += 1) {
    cells.push({ x: margin + index * step, y: margin });
  }
  for (let index = 0; index < CELLS_PER_SIDE; index += 1) {
    cells.push({ x: far, y: margin + index * step });
  }
  for (let index = 0; index < CELLS_PER_SIDE; index += 1) {
    cells.push({ x: far - index * step, y: far });
  }
  for (let index = 0; index < CELLS_PER_SIDE; index += 1) {
    cells.push({ x: margin, y: far - index * step });
  }

  return cells;
}

/** The four corners, where a yard sits. */
export function yardCorner(seatIndex, size = 620, margin = 24) {
  const corners = [
    { x: margin + 20, y: margin + 20 },
    { x: size - margin - 20, y: margin + 20 },
    { x: size - margin - 20, y: size - margin - 20 },
    { x: margin + 20, y: size - margin - 20 },
  ];
  return corners[seatIndex % 4];
}

/** The four slots inside a yard. */
export function yardSlot(seatIndex, token, size = 620, margin = 24) {
  const corner = yardCorner(seatIndex, size, margin);
  const offsets = [
    { x: -14, y: -14 },
    { x: 14, y: -14 },
    { x: -14, y: 14 },
    { x: 14, y: 14 },
  ];
  const offset = offsets[token % 4];
  return { x: corner.x + offset.x, y: corner.y + offset.y };
}

/** Where one token sits, given the seat's progress for it. */
export function pointFor(seatIndex, progress, token, size = 620, margin = 24) {
  const centre = { x: size / 2, y: size / 2 };

  if (progress < 0) {
    return yardSlot(seatIndex, token, size, margin);
  }
  if (progress >= PROGRESS_HOME) {
    const angles = [-2.4, -0.9, 0.9, 2.4];
    const angle = angles[seatIndex % 4];
    const radius = 26 + token * 3;
    return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
  }
  if (progress > PROGRESS_ON_RING) {
    const ring = buildRing(size, margin);
    const corner = ring[(seatIndex * CELLS_PER_SIDE) % RING_CELLS];
    const t = (progress - PROGRESS_ON_RING) / (PROGRESS_HOME - PROGRESS_ON_RING);
    return {
      x: corner.x + (centre.x - corner.x) * t,
      y: corner.y + (centre.y - corner.y) * t,
    };
  }

  const ring = buildRing(size, margin);
  return ring[(seatIndex * CELLS_PER_SIDE + progress) % RING_CELLS];
}

/** Every point a token passes through from one progress value to another. */
export function pathBetween(seatIndex, from, to, token, size = 620) {
  const points = [];
  const step = from <= to ? 1 : -1;
  for (let progress = from; progress !== to + step; progress += step) {
    points.push(pointFor(seatIndex, progress, token, size));
  }
  return points;
}
