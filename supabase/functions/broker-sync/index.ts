import { systemClock } from "@adapters/clock.ts";
import { currentKeyVersion, open, seal } from "@adapters/crypto.ts";
import { createQuoteCacheKv, createServiceClient } from "@adapters/db.ts";
import { requireEnv } from "@adapters/env.ts";
import { createRpcLimiter, flexClientFromEnv } from "@adapters/flex.ts";
import { parseFlexStatement } from "@adapters/flex-parse.ts";
import { allowedOriginsFromEnv } from "@adapters/http.ts";
import { logLine } from "@adapters/log.ts";
import { rpcIncr, withIpRateLimit } from "@adapters/rate-limit.ts";
import { createRiskSetStore, refreshRiskSet } from "@adapters/risk-set.ts";
import { createYahooEnabledCheck } from "@adapters/settings.ts";
import { claimsVerifierFromEnv } from "@adapters/user-auth.ts";
import { createYahooProvider } from "@adapters/yahoo.ts";
import { createClient } from "@supabase/supabase-js";
import { type HandlerDeps, handleRequest, isLocalUrl } from "./handler.ts";
import { matchUserPositions } from "./matching.ts";
import { createMatchPorts, createMatchStore, createSupabaseStore } from "./store.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/** Sofia date "YYYY-MM-DD". */
function sofiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function buildDeps(): HandlerDeps {
  const url = requireEnv("SUPABASE_URL");
  const sb = createServiceClient();
  const env = { get: (name: string) => Deno.env.get(name) };
  const store = createSupabaseStore(sb);
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
  const matchPorts = createMatchPorts(sb, market);
  const matchStore = createMatchStore(sb);
  const riskStore = createRiskSetStore(sb);
  // FLEX_USER_AGENT is mandatory (flexClientFromEnv throws without it); the limiter keeps 1 request/s and 10/min per token across invocations
  const flex = flexClientFromEnv({
    limiter: createRpcLimiter({
      take: async (key) => {
        const { data, error } = await sb.schema("app").rpc("flex_rl_take", { p_key: key });
        if (error) throw new Error("limiter unavailable");
        return Number(data ?? 0);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
  });
  return {
    brokerDeps: {
      store,
      flex,
      keys: {
        seal: (plain, ctx) => seal(plain, ctx, env),
        open: (sealed, ctx) => open(sealed, ctx, env),
        currentVersion: () => currentKeyVersion(env),
      },
      parse: (xml) => parseFlexStatement(xml),
      matcher: {
        matchUserPositions: (userId) => matchUserPositions(userId, matchStore, matchPorts),
      },
      riskSet: {
        refresh: (userId) => refreshRiskSet(riskStore, userId),
        pause: (userId) => riskStore.pause(userId),
        remove: (userId) => riskStore.remove(userId),
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (event, data) => logLine(event, { fn: "broker-sync", ...data }),
      background: (p) => (typeof EdgeRuntime === "undefined" ? void p : EdgeRuntime.waitUntil(p)),
      todayIso: sofiaToday,
      fixtureMode: Deno.env.get("FLEX_FIXTURE_MODE") === "1" && isLocalUrl(url),
    },
    verifier: claimsVerifierFromEnv(createClient as never),
    cronSecret: requireEnv("CRON_SHARED_SECRET"),
    allowedOrigins: allowedOriginsFromEnv(),
  };
}

let deps: HandlerDeps | undefined;
let limited: ((req: Request) => Promise<Response>) | undefined;
Deno.serve((req) => {
  deps ??= buildDeps();
  limited ??= withIpRateLimit((r) => handleRequest(r, deps as HandlerDeps), {
    fn: "broker-sync",
    perMinute: 20,
    salt: requireEnv("RATE_LIMIT_SALT"),
    incr: rpcIncr(createServiceClient()),
  });
  return limited(req);
});
