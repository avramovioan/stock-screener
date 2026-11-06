import { requireEnv } from "@adapters/env.ts";
import { claimsVerifierFromEnv } from "@adapters/user-auth.ts";
import { createClient } from "@supabase/supabase-js";
import { SupabaseCacheStore } from "../quotes/cache.ts";
import { handle } from "./handler.ts";

const db = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const deps = {
  fetch: (input: string, init: RequestInit) => fetch(input, init),
  store: new SupabaseCacheStore(db),
  verifier: claimsVerifierFromEnv(createClient as never),
  now: () => Date.now(),
  siteOrigin: new URL(requireEnv("SITE_URL")).origin,
  rateLimitSalt: requireEnv("RATE_LIMIT_SALT"),
};

Deno.serve((req) => handle(req, deps));
