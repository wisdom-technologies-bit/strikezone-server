import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/lib/canonical-json.js";

describe("canonical JSON", () => {
  it("sorts keys so insertion order cannot change the bytes", () => {
    const first = { b: 2, a: 1, nested: { y: true, x: null } };
    const second = { nested: { x: null, y: true }, a: 1, b: 2 };

    expect(canonicalJson(first)).toBe('{"a":1,"b":2,"nested":{"x":null,"y":true}}');
    expect(canonicalJson(second)).toBe(canonicalJson(first));
  });

  it("keeps array order, because order is data", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ list: [1, 2] })).not.toBe(canonicalJson({ list: [2, 1] }));
  });

  it("serialises primitives like JSON", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(12.5)).toBe("12.5");
    expect(canonicalJson("a\u0000b")).toBe(JSON.stringify("a\u0000b"));
  });

  it("drops undefined members and refuses values that cannot be represented", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });

  it("refuses a cycle instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;

    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
  });

  it("gives equal bytes to equal values, which is what the hash chain needs", () => {
    const event = { shot: 3, seat: 1, shotAngle: 1.5707963267948966, power: 0.72 };
    const copy = JSON.parse(JSON.stringify(event)) as typeof event;

    expect(canonicalJson(copy)).toBe(canonicalJson(event));
  });
});
