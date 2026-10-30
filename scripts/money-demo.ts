/**
 * npm run money:demo
 *
 * The launcher. `src/lib/env.ts` validates the configuration at import time and
 * exits when a variable is missing, so the demo fills in throwaway values before
 * loading anything. It never reads a real key: everything below runs in memory.
 */

process.env.NODE_ENV = "test";
process.env.PORT = "2567";
process.env.SITE_ORIGIN = "https://strikezone.test";
process.env.SUPABASE_URL = "https://demo-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "demo-service-role-key-not-a-real-secret";
process.env.RESULT_SIGNING_SECRET = "demo-result-signing-secret-0123456789abcdef";
process.env.ADMIN_API_KEY = "demo-admin-api-key-0123456789";
process.env.MONEY_MODE = "virtual";
process.env.CURRENCY = "NGN";
process.env.HOUSE_MARGIN_BPS = "600";
process.env.MIN_STAKE_MINOR = "100";
process.env.MATCH_EXPOSURE_PCT = "20";
process.env.LARGE_PAYOUT_MINOR = "5000000";
process.env.MIN_ACCOUNT_AGE_HOURS = "24";
process.env.BET_RATE_LIMIT_PER_MINUTE = "10";

await import("./money-demo-run.js");
