import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * The single server-side Supabase client.
 *
 * It uses the service role key, which bypasses row level security: this client
 * must never be handed to a browser or embedded in anything sent to a client
 * (AI_RULES.md hard rule 5).
 */
export const supabase: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-application-name": "strikezone-server" },
    },
  },
);

export type ConnectionCheck =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * Proves the database is reachable and the service role key is accepted.
 *
 * The probe is PostgREST's root document (`GET /rest/v1/`): it needs no table to
 * exist, so it keeps working before the first migration has been applied, but it
 * still fails when the project is paused, the URL is wrong or the key is bad.
 * The detail string is a coarse reason only, never a response body or a secret.
 */
export async function checkSupabaseConnection(timeoutMs = 5_000): Promise<ConnectionCheck> {
  try {
    const response = await fetch(new URL("/rest/v1/", env.SUPABASE_URL), {
      method: "GET",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { ok: false, detail: `postgrest_http_${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, detail: "timeout" };
    }
    return { ok: false, detail: "unreachable" };
  }
}
