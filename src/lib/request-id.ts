import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * A request id on every request, in the response and in the logs.
 *
 * The header is accepted only when it is a UUID: an id that a caller can put
 * arbitrary text into ends up in log fields, and log injection is a real way to
 * make an audit trail lie. Anything else is replaced with a fresh id.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requestId: RequestHandler = (request, response, next) => {
  const given = request.headers["x-request-id"];
  const candidate = Array.isArray(given) ? given[0] : given;
  const id =
    typeof candidate === "string" && UUID_PATTERN.test(candidate) ? candidate : randomUUID();

  response.locals["requestId"] = id;
  response.setHeader("x-request-id", id);
  next();
};

/** The id on a request that passed the middleware. */
export function requestIdOf(response: { locals: Record<string, unknown> }): string {
  const id = response.locals["requestId"];
  return typeof id === "string" ? id : "unknown";
}
