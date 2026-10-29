import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

describe("GET /api/bots", () => {
  it("publishes every level with its policy, name and numbers", async () => {
    const response = await request(createApp()).get("/api/bots");

    expect(response.status).toBe(200);
    const body = response.body as { ok: boolean; bots: Array<Record<string, unknown>> };

    expect(body.ok).toBe(true);
    expect(body.bots).toHaveLength(3);
    for (const bot of body.bots) {
      expect(bot["isBot"]).toBe(true);
      expect(typeof bot["displayName"]).toBe("string");
      expect(typeof bot["policy"]).toBe("string");
      expect(typeof bot["aimErrorDegrees"]).toBe("number");
      expect(typeof bot["selectionQuality"]).toBe("number");
      expect(String(bot["displayName"]).toLowerCase()).toContain("bot");
    }
  });
});
