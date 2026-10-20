import { requireEnv } from "@adapters/env.ts";
import { logLine } from "@adapters/log.ts";
import { loadPushEnv, sendPush } from "@adapters/push.ts";
import { createClient } from "@supabase/supabase-js";
import { type DispatchDeps, runDispatch } from "./dispatch.ts";
import { handleNotifyDispatch } from "./handler.ts";
import { createDispatchStore } from "./store.ts";

const client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const deps: DispatchDeps = {
  store: createDispatchStore(client),
  sendPush: (sub, payload, opts) => sendPush(sub, payload, opts, { env: loadPushEnv() }),
  nowMs: () => Date.now(),
  siteUrl: requireEnv("SITE_URL"),
  // ids, channels, status classes only: never addresses, endpoints, keys or payloads
  log: (event, data) => logLine(event, data),
};

Deno.serve((req) =>
  handleNotifyDispatch(req, {
    cronSecret: Deno.env.get("CRON_SHARED_SECRET") ?? "",
    run: () => runDispatch(deps, { limit: 20, budgetMs: 100_000 }),
  }),
);
