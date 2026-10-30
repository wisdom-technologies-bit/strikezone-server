/**
 * A fixed-window counter per key.
 *
 * Used for the two places an unauthenticated caller can spend something the
 * server owns: taking a spectator seat, and calling the public API. A fixed
 * window lets a caller burst across a boundary, which is acceptable here because
 * the cost of the burst is bounded by the window size, and a sliding window
 * would need a timestamp per request to buy back something the cap already
 * bounds.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, now: () => number = Date.now, windowMs = 60_000) {
    this.#limit = limit;
    this.#now = now;
    this.#windowMs = windowMs;
  }

  /** True when the call is allowed, and counts it. */
  take(key: string): boolean {
    const now = this.#now();
    const window = this.#windows.get(key);

    if (window === undefined || now - window.start >= this.#windowMs) {
      this.#windows.set(key, { start: now, count: 1 });
      this.#prune(now);
      return true;
    }

    if (window.count >= this.#limit) {
      return false;
    }

    window.count += 1;
    return true;
  }

  /** How long until this key's window resets, in seconds. Zero when it is open. */
  retryAfterSeconds(key: string): number {
    const window = this.#windows.get(key);
    if (window === undefined) {
      return 0;
    }
    const remaining = window.start + this.#windowMs - this.#now();
    return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
  }

  #prune(now: number): void {
    if (this.#windows.size < 1024) {
      return;
    }
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) {
        this.#windows.delete(key);
      }
    }
  }
}
