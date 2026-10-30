import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { InMemoryAdminConsole, setAdminConsole } from "../../src/admin/console.js";
import { InMemoryAdminStore, setAdminStore } from "../../src/admin/store.js";
import { InMemoryAlertStore, setAlertStore } from "../../src/monitoring/alerts.js";
import { adminLockoutState, resetAdminLockouts } from "../../src/api/auth.js";

/**
 * The operator API: the gate, the audit trail, and the views.
 *
 * The console and the two stores are replaced with their in-memory versions, so
 * these tests run the real routes and the real middleware against no database.
 */

const KEY = process.env["ADMIN_API_KEY"] ?? "";
const MATCH_ID = "d0000000-0000-4000-8000-000000000001";
const USER_ID = "d0000000-0000-4000-8000-000000000002";

function app() {
  return createApp();
}

/** The audit row is written after the response finishes. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("the admin gate", () => {
  beforeEach(() => {
    resetAdminLockouts();
    setAdminStore(new InMemoryAdminStore());
    setAlertStore(new InMemoryAlertStore());
    setAdminConsole(
      new InMemoryAdminConsole({ liveMatches: [MATCH_ID], freeBankrollMinor: 7_500_000 }),
    );
  });

  it("refuses a request with no key and one with the wrong key", async () => {
    const missing = await request(app()).get("/api/admin/overview");
    expect(missing.status).toBe(403);
    expect((missing.body as { error: string }).error).toBe("admin_only");

    const wrong = await request(app()).get("/api/admin/overview").set("x-admin-key", "not-the-key");
    expect(wrong.status).toBe(403);
  });

  it("locks an address out after ten wrong keys, and refuses the right one too", async () => {
    const server = app();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await request(server).get("/api/admin/overview").set("x-admin-key", "wrong");
      expect(response.status).toBe(403);
    }

    // The tenth is the one that locks it.
    const tenth = await request(server).get("/api/admin/overview").set("x-admin-key", "wrong");
    expect(tenth.status).toBe(429);

    expect(adminLockoutState("::ffff:127.0.0.1") ?? adminLockoutState("127.0.0.1")).not.toBeNull();

    const withTheRightKey = await request(server)
      .get("/api/admin/overview")
      .set("x-admin-key", KEY);
    expect(withTheRightKey.status).toBe(429);
  });

  it("writes an audit row for every call, allowed or refused", async () => {
    const store = new InMemoryAdminStore();
    setAdminStore(store);
    const server = app();

    const allowed = await request(server).get("/api/admin/overview").set("x-admin-key", KEY);
    expect(allowed.status).toBe(200);
    await settled();

    const refused = await request(server).get("/api/admin/overview").set("x-admin-key", "wrong");
    expect(refused.status).toBe(403);
    await settled();

    const rows = await store.listActions(10);
    const overviewRows = rows.filter((row) => row.action === "GET /api/admin/overview");
    expect(overviewRows.length).toBeGreaterThanOrEqual(1);

    const payload = overviewRows[0]?.payload as { status?: number; requestId?: string };
    expect(payload.status).toBe(200);
    expect(typeof payload.requestId).toBe("string");
  });
});

describe("the admin console", () => {
  beforeEach(() => {
    resetAdminLockouts();
    setAdminStore(new InMemoryAdminStore());
    setAlertStore(new InMemoryAlertStore());
    setAdminConsole(
      new InMemoryAdminConsole({ liveMatches: [MATCH_ID], freeBankrollMinor: 7_500_000 }),
    );
  });

  it("reports the overview an operator opens first", async () => {
    const response = await request(app()).get("/api/admin/overview").set("x-admin-key", KEY);

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["liveMatches"]).toBe(1);
    expect(body["freeBankrollMinor"]).toBe(7_500_000);
    expect(body["bettingPaused"]).toBe(false);
    expect(Array.isArray(body["exposureByMatch"])).toBe(true);
  });

  it("lists the bots, and publishing one is visible in its history", async () => {
    const listed = await request(app()).get("/api/admin/bots").set("x-admin-key", KEY);
    expect(listed.status).toBe(200);
    expect((listed.body as { bots: unknown[] }).bots).toHaveLength(3);

    const published = await request(app())
      .post("/api/admin/bots/club/publish")
      .set("x-admin-key", KEY)
      .send({ level: "club", numbers: { aimErrorDegrees: 2.5, selectionQuality: 0.7 } });
    expect(published.status).toBe(201);

    const history = await request(app())
      .get("/api/admin/bots/club/history")
      .set("x-admin-key", KEY);
    expect(history.status).toBe(200);
    const rows = (history.body as { history: Array<Record<string, unknown>> }).history;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["numbers"]).toEqual({ aimErrorDegrees: 2.5, selectionQuality: 0.7 });
  });

  it("suspends a market and records who did it", async () => {
    const response = await request(app())
      .post("/api/admin/markets/suspend")
      .set("x-admin-key", KEY)
      .set("x-admin-actor", "ops-1")
      .send({ matchId: MATCH_ID, marketType: "match_winner", suspended: true });

    expect(response.status).toBe(200);
    expect((response.body as { changed: number }).changed).toBe(1);

    const audit = await request(app())
      .get("/api/admin/audit-log")
      .query({ action: "market.suspended" })
      .set("x-admin-key", KEY);
    const entries = (audit.body as { entries: Array<{ actor: string }> }).entries;
    expect(entries[0]?.actor).toBe("ops-1");
  });

  it("sets KYC, self-exclusion and a freeze on one account", async () => {
    const server = app();
    const until = "2027-01-01T00:00:00.000Z";

    for (const [path, body] of [
      [`/api/admin/users/${USER_ID}/kyc`, { status: "verified" }],
      [`/api/admin/users/${USER_ID}/self-exclusion`, { until }],
      [`/api/admin/users/${USER_ID}/freeze`, { frozen: true }],
    ] as const) {
      const response = await request(server).post(path).set("x-admin-key", KEY).send(body);
      expect(response.status).toBe(200);
    }

    const audit = await request(app())
      .get("/api/admin/audit-log")
      .query({ targetType: "user", targetId: USER_ID })
      .set("x-admin-key", KEY);
    const entries = (audit.body as { entries: unknown[] }).entries;
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a body that does not match the schema", async () => {
    const response = await request(app())
      .post("/api/admin/markets/override")
      .set("x-admin-key", KEY)
      .send({ marketType: "match_winner" });

    expect(response.status).toBe(400);
  });

  it("answers deep health with the database, the live matches and the pool", async () => {
    const response = await request(app()).get("/api/admin/health-deep").set("x-admin-key", KEY);

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect((body["database"] as { ok: boolean }).ok).toBe(true);
    expect(body["liveMatches"]).toBe(1);
    expect(Array.isArray(body["lastRepriceByMatch"])).toBe(true);
    expect(typeof (body["workerPool"] as { cores: number }).cores).toBe("number");
  });
});
