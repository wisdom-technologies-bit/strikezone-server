/**
 * Test environment.
 *
 * src/lib/env.ts validates the configuration at import time, so every variable
 * must look real before any module is loaded. These values are throwaway fakes:
 * no test talks to a live Supabase project.
 */
process.env.NODE_ENV = "test";
process.env.PORT = "2567";
process.env.SITE_ORIGIN = "https://strikezone.test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-not-a-real-secret";
process.env.RESULT_SIGNING_SECRET = "test-result-signing-secret-0123456789abcdef";
process.env.ADMIN_API_KEY = "test-admin-api-key-0123456789";
process.env.MONEY_MODE = "virtual";
process.env.CURRENCY = "NGN";
process.env.HOUSE_MARGIN_BPS = "600";
