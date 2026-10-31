/**
 * The production start guard.
 *
 * Two values decide whether a production process may exist at all: the operator
 * key that reaches the admin routes, and the secret that signs match results. A
 * process that comes up without them is either takeable over or unable to prove a
 * match, so the guard refuses rather than warns.
 *
 * The placeholder cases matter as much as the empty ones: `.env.example` ships
 * values long enough to satisfy every length check, so copying it to a host is
 * the likeliest way an example secret reaches production.
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { productionProblems } from "../../src/lib/env.js";

/** A value of the right shape, generated rather than typed. */
function secret(): string {
  return randomBytes(32).toString("hex");
}

const real = {
  NODE_ENV: "production",
  ADMIN_API_KEY: secret(),
  RESULT_SIGNING_SECRET: secret(),
  SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: secret(),
};

describe("the production start guard", () => {
  it("says nothing outside production", () => {
    expect(
      productionProblems({
        NODE_ENV: "development",
        ADMIN_API_KEY: "short",
        RESULT_SIGNING_SECRET: "",
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
      }),
    ).toEqual([]);
  });

  it("accepts a real production environment", () => {
    expect(productionProblems(real)).toEqual([]);
  });

  it("refuses an admin key shorter than 32 characters", () => {
    const problems = productionProblems({ ...real, ADMIN_API_KEY: "tooshort-to-pass-the-guard" });
    expect(problems).toContain("ADMIN_API_KEY must be at least 32 characters in production");
  });

  it("refuses a missing signing secret", () => {
    expect(productionProblems({ ...real, RESULT_SIGNING_SECRET: "   " })).toContain(
      "RESULT_SIGNING_SECRET must be set in production",
    );
  });

  it("refuses the example values even though they are long enough", () => {
    const problems = productionProblems({
      NODE_ENV: "production",
      ADMIN_API_KEY: "replace-with-a-random-admin-api-key",
      RESULT_SIGNING_SECRET: "replace-with-a-random-string-at-least-32-characters-long",
      SUPABASE_URL: "https://your-project-ref.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "replace-with-your-supabase-service-role-key",
    });

    expect(problems).toContain("ADMIN_API_KEY is still the example value from .env.example");
    expect(problems).toContain(
      "RESULT_SIGNING_SECRET is still the example value from .env.example",
    );
    expect(problems).toContain(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be the project values, not the example ones",
    );
  });

  it("names every problem at once, so one restart fixes all of them", () => {
    const problems = productionProblems({
      NODE_ENV: "production",
      ADMIN_API_KEY: "short",
      RESULT_SIGNING_SECRET: "",
      SUPABASE_URL: "https://your-project-ref.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "",
    });
    expect(problems).toHaveLength(3);
  });
});
