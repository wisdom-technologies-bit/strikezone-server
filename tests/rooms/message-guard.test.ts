import { describe, expect, it } from "vitest";
import { createMessageGuard, messageBytes } from "../../src/rooms/message-guard.js";

/**
 * The room message caps.
 *
 * A room accepts whatever a client sends unless somebody stops it, so these are
 * the two stops: size and rate. The clock is injected, which is the only way to
 * test a rate without sleeping through it.
 */
describe("the room message guard", () => {
  it("measures a message in the bytes it arrived in", () => {
    expect(messageBytes("abc")).toBe(3);
    expect(messageBytes({ token: 1 })).toBe(Buffer.byteLength('{"token":1}', "utf8"));
    expect(messageBytes("é")).toBe(2);
  });

  it("refuses a message over the size limit and counts it", () => {
    const guard = createMessageGuard({ maxBytes: 16, maxPerSecond: 100, now: () => 0 });
    expect(guard.check("a", { token: 1 })).toBe("ok");
    expect(guard.check("a", { token: 1, padding: "x".repeat(100) })).toBe("too_large");
    expect(guard.violations("a")).toBe(1);
  });

  it("allows the burst it is configured for and refuses the one after", () => {
    let clock = 0;
    const guard = createMessageGuard({ maxBytes: 1_000, maxPerSecond: 3, now: () => clock });

    expect(guard.check("a", { token: 1 })).toBe("ok");
    expect(guard.check("a", { token: 1 })).toBe("ok");
    expect(guard.check("a", { token: 1 })).toBe("ok");
    expect(guard.check("a", { token: 1 })).toBe("too_fast");

    // The next second starts empty again.
    clock = 1_001;
    expect(guard.check("a", { token: 1 })).toBe("ok");
  });

  it("counts each client separately", () => {
    const guard = createMessageGuard({ maxBytes: 1_000, maxPerSecond: 1, now: () => 0 });
    expect(guard.check("a", {})).toBe("ok");
    expect(guard.check("a", {})).toBe("too_fast");
    expect(guard.check("b", {})).toBe("ok");
    expect(guard.violations("b")).toBe(0);
  });

  it("forgets violations older than a minute", () => {
    let clock = 0;
    const guard = createMessageGuard({ maxBytes: 8, maxPerSecond: 100, now: () => clock });
    expect(guard.check("a", "far too long to fit")).toBe("too_large");
    expect(guard.violations("a")).toBe(1);

    clock = 61_000;
    expect(guard.violations("a")).toBe(0);
  });
});
