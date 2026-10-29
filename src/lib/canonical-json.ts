/**
 * Canonical JSON: one and only one serialisation for a given value.
 *
 * The match log hashes events and signs results, so two servers writing the same
 * data must produce the same bytes. `JSON.stringify` does not guarantee that:
 * object key order follows insertion order. This sorts keys, keeps array order,
 * and refuses values that would vanish silently (`undefined`, functions, symbols)
 * because a hash over a value that serialises to nothing is a hash over nothing.
 *
 * Numbers are written with `JSON.stringify`, so a value is only safe to hash if it
 * round-trips exactly: the match log stores scores, shot angles and coin
 * positions, which do.
 */

/** Values that can be canonicalised. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/** Serialises a value to canonical JSON. */
export function canonicalJson(value: unknown): string {
  return write(value, new Set<object>());
}

function write(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("canonical JSON cannot represent a non-finite number");
      }
      return JSON.stringify(value);
    }
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonical JSON cannot represent a ${typeof value}`);
  }

  const object = value as object;

  if (seen.has(object)) {
    throw new TypeError("canonical JSON cannot represent a cycle");
  }
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      const items = object.map((item: unknown) => write(item, seen));
      return `[${items.join(",")}]`;
    }

    const entries = Object.entries(object as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined,
    );
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    const body = entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${write(entry, seen)}`)
      .join(",");

    return `{${body}}`;
  } finally {
    seen.delete(object);
  }
}

/** A deep copy of a JSON value, normalised through canonical JSON. */
export function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
