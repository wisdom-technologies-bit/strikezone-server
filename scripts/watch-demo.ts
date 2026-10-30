/**
 * The launcher fills in throwaway configuration before anything is imported,
 * because src/lib/env.ts validates at import time.
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

await import("./watch-demo-run.js");
