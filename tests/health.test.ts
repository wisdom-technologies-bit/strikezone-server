import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { APP_VERSION } from "../src/lib/version.js";

describe("GET /health", () => {
  it("reports the process as healthy with a version and uptime", async () => {
    const response = await request(createApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, version: APP_VERSION });

    const { uptimeSeconds } = response.body as { uptimeSeconds: unknown };
    expect(typeof uptimeSeconds).toBe("number");
    expect(uptimeSeconds as number).toBeGreaterThanOrEqual(0);
  });
});
