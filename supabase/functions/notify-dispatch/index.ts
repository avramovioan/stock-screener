import { requireEnv } from "@adapters/env.ts";
import { logLine } from "@adapters/log.ts";
import { loadPushEnv, sendPush } from "@adapters/push.ts";
import { loadTelegramEnv, sendTelegramMessage } from "@adapters/telegram.ts";
import { createClient } from "@supabase/supabase-js";
import { type DispatchDeps, runDispatch } from "./dispatch.ts";
import { handleNotifyDispatch } from "./handler.ts";
import { createDispatchStore } from "./store.ts";

const client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Read when a run starts: both secrets set means the Telegram group is on, either unset means off
function telegramSender(): DispatchDeps["telegram"] {
  const env = loadTelegramEnv();
  return env === null ? null : { send: (text) => sendTelegramMessage(env, text) };
}

const deps: DispatchDeps = {
  store: createDispatchStore(client),
  sendPush: (sub, payload, opts) => sendPush(sub, payload, opts, { env: loadPushEnv() }),
  get telegram() {
    return telegramSender();
  },
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
