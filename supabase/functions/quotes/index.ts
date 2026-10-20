import { requireEnv } from "@adapters/env.ts";
import { createClient } from "@supabase/supabase-js";
import { SupabaseCacheStore } from "./cache.ts";
import { handle } from "./handler.ts";
import { createProvider } from "./provider.ts";

const db = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const deps = {
  provider: createProvider(db),
  store: new SupabaseCacheStore(db),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  siteOrigin: new URL(requireEnv("SITE_URL")).origin,
  rateLimitSalt: requireEnv("RATE_LIMIT_SALT"),
};

Deno.serve((req) => handle(req, deps));
