import { Router } from "express";
import { z } from "zod";
import { BOT_LEVELS, adminConsole } from "../admin/console.js";
import { requireAdmin } from "./auth.js";

/**
 * The operator's console over HTTP.
 *
 * Every route is behind `requireAdmin` (a constant-time key, a per-address
 * lockout, and an audit row per call). Reads answer with numbers the console has
 * already aggregated; writes validate with Zod, do one thing, and answer with what
 * changed. The money routes live in admin-money.ts and the tournament controls in
 * admin-tournaments.ts; this router is the rest of the surface, plus the views an
 * operator opens first.
 */

const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

const publishSchema = z.strictObject({
  level: z.enum(BOT_LEVELS),
  /**
   * A published number: an aim error in degrees, a selection quality as a rate,
   * a skill score. Bounded rather than typed per key, because the catalogue owns
   * what each number means and this route only records what was published.
   */
  numbers: z.record(z.string().min(1).max(40), z.number().min(0).max(1_000)),
  note: z.string().max(200).optional(),
});

const idParam = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, "is not a safe id");

const suspendSchema = z.strictObject({
  matchId: z.uuid(),
  marketType: z.string().min(1).max(64),
  subject: z.string().max(64).optional(),
  line: z.number().nullable().optional(),
  suspended: z.boolean(),
});

const overrideSchema = z
  .strictObject({
    marketType: z.string().min(1).max(64),
    maxStakeMinor: z.number().int().min(1).max(1_000_000_000).optional(),
    marginBps: z.number().int().min(0).max(5_000).optional(),
    note: z.string().max(200).optional(),
  })
  .refine(
    (value) => value.maxStakeMinor !== undefined || value.marginBps !== undefined,
    "an override needs a stake ceiling, a margin, or both",
  );

const selfExclusionSchema = z.strictObject({
  /** An ISO instant, or null to lift the exclusion. */
  until: z.iso.datetime().nullable(),
});

const kycSchema = z.strictObject({ status: z.enum(["none", "pending", "verified", "rejected"]) });
const freezeSchema = z.strictObject({ frozen: z.boolean() });

/** The operator named themselves in `x-admin-actor`, or they are "admin". */
function actorOf(response: { locals: Record<string, unknown> }): string {
  const actor = response.locals["adminActor"];
  return typeof actor === "string" ? actor : "admin";
}

export function createAdminRouter(): Router {
  const router = Router();
  const console_ = (): ReturnType<typeof adminConsole> => adminConsole();

  /** Overview: what is live, what it is exposed to, and what needs a person. */
  router.get("/api/admin/overview", requireAdmin, (_request, response, next) => {
    void (async () => {
      try {
        response.json({ ok: true, ...(await console_().overview()) });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** Deep health, for a monitor rather than a load balancer. */
  router.get("/api/admin/health-deep", requireAdmin, (_request, response, next) => {
    void (async () => {
      try {
        const health = await console_().health();
        response.status(health.database.ok ? 200 : 503).json({ ...health, ok: health.database.ok });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** The audit trail, filtered. */
  router.get("/api/admin/audit-log", requireAdmin, (request, response, next) => {
    const parsed = z
      .strictObject({
        action: z.string().min(1).max(80).optional(),
        targetType: z.string().min(1).max(40).optional(),
        targetId: z.string().min(1).max(120).optional(),
        limit: limitSchema.optional(),
      })
      .safeParse(request.query);

    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        const entries = await console_().auditLog({
          action: parsed.data.action,
          targetType: parsed.data.targetType,
          targetId: parsed.data.targetId,
          limit: parsed.data.limit ?? 50,
        });
        response.json({ ok: true, entries, count: entries.length });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** Open alerts. */
  router.get("/api/admin/alerts", requireAdmin, (request, response, next) => {
    const parsed = z.strictObject({ limit: limitSchema.optional() }).safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        const alerts = await console_().alerts(parsed.data.limit ?? 50);
        response.json({ ok: true, alerts, count: alerts.length });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** The bots, and the numbers each one publishes today. */
  router.get("/api/admin/bots", requireAdmin, (_request, response, next) => {
    void (async () => {
      try {
        const bots = await console_().listBots();
        response.json({ ok: true, bots });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** One bot's published history. */
  router.get("/api/admin/bots/:botId/history", requireAdmin, (request, response, next) => {
    const parsed = idParam.safeParse(request.params.botId);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        const history = await console_().botHistory(parsed.data);
        response.json({ ok: true, botId: parsed.data, history });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** Publish a bot's numbers. Audited, and visible in the bot's public history. */
  router.post("/api/admin/bots/:botId/publish", requireAdmin, (request, response, next) => {
    const botId = idParam.safeParse(request.params.botId);
    const body = publishSchema.safeParse(request.body);

    if (!botId.success || !body.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        const bot = await console_().publishBot(
          {
            botId: botId.data,
            level: body.data.level,
            numbers: body.data.numbers,
            note: body.data.note,
          },
          actorOf(response),
        );
        response.status(201).json({ ok: true, bot });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** Suspend or resume one market of one match. */
  router.post("/api/admin/markets/suspend", requireAdmin, (request, response, next) => {
    const parsed = suspendSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        const changed = await console_().suspendMarket(parsed.data, actorOf(response));
        response.json({ ok: true, changed, suspended: parsed.data.suspended });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** A market type's stake ceiling and margin, applied from the next price on. */
  router.post("/api/admin/markets/override", requireAdmin, (request, response, next) => {
    const parsed = overrideSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        await console_().setMarketOverride(parsed.data, actorOf(response));
        response.status(201).json({ ok: true });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** Set or lift a player's self-exclusion. */
  router.post(
    "/api/admin/users/:userId/self-exclusion",
    requireAdmin,
    (request, response, next) => {
      const userId = z.uuid().safeParse(request.params.userId);
      const body = selfExclusionSchema.safeParse(request.body);
      if (!userId.success || !body.success) {
        response.status(400).json({ ok: false, error: "invalid_request" });
        return;
      }

      void (async () => {
        try {
          await console_().setSelfExclusion(userId.data, body.data.until, actorOf(response));
          response.json({ ok: true, userId: userId.data, until: body.data.until });
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  /** Mark an identity check. */
  router.post("/api/admin/users/:userId/kyc", requireAdmin, (request, response, next) => {
    const userId = z.uuid().safeParse(request.params.userId);
    const body = kycSchema.safeParse(request.body);
    if (!userId.success || !body.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        await console_().setKyc(userId.data, body.data.status, actorOf(response));
        response.json({ ok: true, userId: userId.data, status: body.data.status });
      } catch (error) {
        next(error);
      }
    })();
  });

  /** Freeze an account, or thaw it. */
  router.post("/api/admin/users/:userId/freeze", requireAdmin, (request, response, next) => {
    const userId = z.uuid().safeParse(request.params.userId);
    const body = freezeSchema.safeParse(request.body);
    if (!userId.success || !body.success) {
      response.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    void (async () => {
      try {
        await console_().setFrozen(userId.data, body.data.frozen, actorOf(response));
        response.json({ ok: true, userId: userId.data, frozen: body.data.frozen });
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
