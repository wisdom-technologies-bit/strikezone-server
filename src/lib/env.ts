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
  MIN_STAKE_MINOR: z.coerce.number().int().min(1).default(100),
  /** How much of the free bankroll one match's exposure may take, in percent. */
  MATCH_EXPOSURE_PCT: z.coerce.number().min(0.01).max(100).default(20),
  /** A payout above this waits for an admin before it is released. */
  LARGE_PAYOUT_MINOR: z.coerce.number().int().min(1).default(5_000_000),
  /** How long an account must exist before real money can be withdrawn. */
  MIN_ACCOUNT_AGE_HOURS: z.coerce.number().min(0).default(24),
  /** Bets one player may place in any one minute. Mirrored in place_bet. */
  BET_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
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
 * Validates a raw environment and returns a typed, frozen config object.
 *
 * @throws {EnvValidationError} when a required variable is missing or invalid.
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
