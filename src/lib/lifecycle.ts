/**
 * Process lifecycle state.
 *
 * `isShuttingDown()` is true from the moment SIGTERM/SIGINT is received until
 * the process exits. Rooms and HTTP routes must consult it before accepting new
 * matches or creating rooms, so a draining instance never starts a new game.
 */

let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
