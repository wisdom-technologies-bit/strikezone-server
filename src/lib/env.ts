import "dotenv/config";
import { z } from "zod";

/**
 * Environment loading and validation.
 *
 * Every secret and every tunable value is read here and nowhere else
 * (AI_RULES.md hard rule 5). Nothing in this module logs a variable value: only
 * variable names and validation messages are ever printed, so a failed start can
 * never leak a secret into the process output.
 */

/** Variables that have no safe default: the process refuses to start without them. */
const requiredVariables = [
  "NODE_ENV",
  "PORT",
  "SITE_ORIGIN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESULT_SIGNING_SECRET",
  "ADMIN_API_KEY",
  "MONEY_MODE",
] as const;

const nodeEnvSchema = z.enum(["development", "test", "production"]);
const moneyModeSchema = z.enum(["virtual", "real"]);

const httpUrlSchema = z
  .url()
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "must be an http(s) URL",
  );

const envSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  PORT: z.coerce.number().int().min(1).max(65_535),
  SITE_ORIGIN: httpUrlSchema,
  SUPABASE_URL: httpUrlSchema,
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "must be at least 20 characters"),
  RESULT_SIGNING_SECRET: z.string().min(32, "must be at least 32 characters"),
  ADMIN_API_KEY: z.string().min(24, "must be at least 24 characters"),
  MONEY_MODE: moneyModeSchema,
  CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 code, for example NGN")
    .default("NGN"),
  /** House margin in basis points: 600 = 6.00%. */
  HOUSE_MARGIN_BPS: z.coerce.number().int().min(0).max(10_000).default(600),
  /** The smallest stake a bet may carry, in minor units. */
  MAX_STAKE_MINOR: z.coerce.number().int().min(1).default(5_000_000),
  MIN_STAKE_MINOR: z.coerce.number().int().min(1).default(100),
  /** How much of the free bankroll one match's exposure may take, in percent. */
  MATCH_EXPOSURE_PCT: z.coerce.number().min(0.01).max(100).default(20),
  /** A payout above this waits for an admin before it is released. */
  LARGE_PAYOUT_MINOR: z.coerce.number().int().min(1).default(5_000_000),
  /** How long an account must exist before real money can be withdrawn. */
  MIN_ACCOUNT_AGE_HOURS: z.coerce.number().min(0).default(24),
  /** Bets one player may place in any one minute. Mirrored in place_bet. */
  BET_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  MAX_SPECTATORS_PER_ROOM: z.coerce.number().int().min(0).max(50_000).default(2000),
  SPECTATOR_JOIN_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  PUBLIC_API_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  /** Requests one IP may make in a minute, over the whole HTTP surface. */
  GLOBAL_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(600),
  /** The largest JSON body the server will read, in kilobytes. */
  BODY_LIMIT_KB: z.coerce.number().int().min(16).max(1024).default(100),
  /** Wrong admin keys one IP may send before it is locked out. */
  ADMIN_LOCKOUT_THRESHOLD: z.coerce.number().int().min(1).max(100).default(10),
  /** How long a locked-out IP stays locked, in milliseconds. */
  ADMIN_LOCKOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),
  /** Warn when the free bankroll falls below this, in minor units. */
  ALERT_FREE_BANKROLL_MINOR: z.coerce.number().int().min(0).default(1_000_000),
  /** Where alerts are POSTed. Unset means rows only, which is the safe default. */
  ALERT_WEBHOOK_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith("http://") || value.startsWith("https://"),
      "must be an http(s) URL",
    )
    .optional(),
  /** Sentry is optional: without a DSN nothing is sent and nothing is logged. */
  SENTRY_DSN: z.string().url().optional(),
  /** The largest Colyseus message a client may send, in bytes. */
  MAX_MESSAGE_BYTES: z.coerce.number().int().min(256).max(1_048_576).default(4_096),
  /** Messages one client may send in a second before the room throttles it. */
  MAX_MESSAGES_PER_SECOND: z.coerce.number().int().min(1).max(1_000).default(20),

  // --- House fixtures -------------------------------------------------------
  // Off by default: deploying this code changes nothing until an operator turns
  // it on. Every other value has a working default, so switching it on is one
  // variable.
  /** Whether the house keeps the lobby supplied with bot matches. */
  FIXTURES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** How many bot fixtures stay in `scheduled` at once. Zero pauses creation. */
  UPCOMING_FIXTURES_TARGET: z.coerce.number().int().min(0).max(24).default(4),
  /** The gap between two fixtures' start times, in minutes. */
  FIXTURE_INTERVAL_MINUTES: z.coerce.number().min(1).max(240).default(5),
  /** How long a fixture's pre-match markets are open before it starts, in seconds. */
  BET_WINDOW_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),
  /** Bot matches allowed to run at the same time. The host is small. */
  MAX_CONCURRENT_HOUSE_MATCHES: z.coerce.number().int().min(1).max(8).default(2),
  /** The games fixtures alternate between, in order. */
  FIXTURE_GAMES: z
    .string()
    .default("carrom,ludo")
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part !== ""),
    )
    .pipe(
      z
        .array(z.enum(["carrom", "ludo"]))
        .min(1, "must name at least one game")
        .max(4)
        .refine((games) => new Set(games).size === games.length, "must not repeat a game"),
    ),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        "Environment configuration is invalid:",
        ...issues.map((issue) => `  - ${issue}`),
        "",
        "Copy .env.example to .env and fill in every value (see README.md).",
      ].join("\n"),
    );
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

function describeIssues(source: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];

  for (const name of requiredVariables) {
    const raw = source[name];
    if (raw === undefined || raw.trim() === "") {
      issues.push(`${name} is missing`);
    }
  }

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // Only the variable path and the validation message are exposed, never the value.
      const path = issue.path.join(".") || "(root)";
      if (issues.some((existing) => existing.startsWith(`${path} is missing`))) {
        continue;
      }
      issues.push(`${path}: ${issue.message}`);
    }
  }

  return issues;
}

/**
 * The checks that only apply to a production start.
 *
 * These are refusals, not warnings: a production process that comes up with a
 * short operator key or no result secret is a process that can be taken over or
 * cannot prove a match. It is better that it never comes up.
 */
export function productionProblems(config: {
  readonly NODE_ENV: string;
  readonly ADMIN_API_KEY: string;
  readonly RESULT_SIGNING_SECRET?: string;
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string;
}): string[] {
  if (config.NODE_ENV !== "production") {
    return [];
  }

  const problems: string[] = [];
  if (config.ADMIN_API_KEY.length < 32) {
    problems.push("ADMIN_API_KEY must be at least 32 characters in production");
  }

  const secret = (config.RESULT_SIGNING_SECRET ?? "").trim();
  if (secret === "") {
    problems.push("RESULT_SIGNING_SECRET must be set in production");
  } else if (isPlaceholder(secret)) {
    problems.push("RESULT_SIGNING_SECRET is still the example value from .env.example");
  }

  // A long placeholder passes every length check and is the likeliest way a
  // copied example file reaches a host. Naming it is the difference between a
  // refusal now and an open admin route later.
  if (isPlaceholder(config.ADMIN_API_KEY)) {
    problems.push("ADMIN_API_KEY is still the example value from .env.example");
  }
  if (
    isPlaceholder(config.SUPABASE_URL ?? "") ||
    isPlaceholder(config.SUPABASE_SERVICE_ROLE_KEY ?? "")
  ) {
    problems.push(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be the project values, not the example ones",
    );
  }

  return problems;
}

/** True for the values shipped in `.env.example`, which are never real. */
function isPlaceholder(value: string): boolean {
  const text = value.trim().toLowerCase();
  return (
    text.startsWith("replace-with") ||
    text.startsWith("change-me") ||
    text.includes("your-project-ref")
  );
}

/**
 * Validates a raw environment and returns a typed, frozen config object.
 *
 * @throws {EnvValidationError} when a required variable is missing or invalid,
 * or when production is about to start with an unsafe configuration.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const issues = describeIssues(source);
  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const unsafe = productionProblems(parsed.data);
  if (unsafe.length > 0) {
    throw new EnvValidationError(unsafe);
  }

  return Object.freeze(parsed.data);
}

function loadEnvOrExit(): Env {
  try {
    return loadEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Printed before the logger exists, so `console` is the only option here.
      console.error(`[strikezone-server] refusing to start.\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

/** The validated configuration for this process. */
export const env: Env = loadEnvOrExit();
