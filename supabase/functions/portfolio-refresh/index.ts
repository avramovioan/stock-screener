import { systemClock } from "@adapters/clock.ts";
import { createQuoteCacheKv, createServiceClient } from "@adapters/db.ts";
import { requireEnv } from "@adapters/env.ts";
import { allowedOriginsFromEnv } from "@adapters/http.ts";
import { logLine } from "@adapters/log.ts";
import { rpcIncr, withIpRateLimit } from "@adapters/rate-limit.ts";
import { createYahooEnabledCheck } from "@adapters/settings.ts";
import { claimsVerifierFromEnv } from "@adapters/user-auth.ts";
import { createYahooProvider } from "@adapters/yahoo.ts";
import { createClient } from "@supabase/supabase-js";
import { handleRequest, type RefreshDeps } from "./handler.ts";
import { createCachedQuoteSource } from "./quotes.ts";
import { createQuoteKv, createRefreshStore } from "./store.ts";

function buildDeps(): RefreshDeps {
  const sb = createServiceClient();
  const market = createYahooProvider({
    fetchImpl: fetch,
    store: createQuoteCacheKv(sb),
    clock: systemClock,
    isEnabled: createYahooEnabledCheck(
      async () =>
        (await sb.from("app_settings").select("value").eq("key", "providers").maybeSingle()).data
          ?.value,
      Date.now,
    ),
  });
  return {
    verifier: claimsVerifierFromEnv(createClient as never),
    store: createRefreshStore(sb),
    quotes: createCachedQuoteSource({
      kv: createQuoteKv(sb),
      market: { quote: (symbols) => market.quote(symbols) as never },
      nowMs: () => Date.now(),
    }),
    nowMs: () => Date.now(),
    allowedOrigins: allowedOriginsFromEnv(),
    log: (event, data) => logLine(event, { fn: "portfolio-refresh", ...data }),
  };
}

let deps: RefreshDeps | undefined;
let limited: ((req: Request) => Promise<Response>) | undefined;
Deno.serve((req) => {
  deps ??= buildDeps();
  limited ??= withIpRateLimit((r) => handleRequest(r, deps as RefreshDeps), {
    fn: "portfolio-refresh",
    perMinute: 60,
    salt: requireEnv("RATE_LIMIT_SALT"),
    incr: rpcIncr(createServiceClient()),
  });
  return limited(req);
});
