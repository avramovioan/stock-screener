import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Browser client. Only the public URL and the anon (publishable) key may be used here; RLS is the
 * protection. PKCE is explicit because the research does not state that it is the default
 * (spec 11.1).
 */
export function createSupabaseClient(url: string, anonKey: string) {
  return createClient<Database>(url, anonKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

// P4-D11: an empty build must still render the shell (P0 builds without these variables in CI);
// P0's deploy guard rejects empty or localhost values for production.
const url = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "missing-anon-key";
if (import.meta.env.MODE !== "test" && !import.meta.env.VITE_SUPABASE_URL) {
  console.error(
    "VITE_SUPABASE_URL is not set; data requests will fail (see apps/web/.env.example)",
  );
}

/** Singleton anon client. */
export const supabase = createSupabaseClient(url, anonKey);

export type AppSupabaseClient = typeof supabase;
