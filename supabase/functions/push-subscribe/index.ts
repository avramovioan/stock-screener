import { requireEnv } from "@adapters/env.ts";
import { allowedOriginsFromEnv } from "@adapters/http.ts";
import { loadPushEnv, sendPush } from "@adapters/push.ts";
import { rpcIncr, withIpRateLimit } from "@adapters/rate-limit.ts";
import { claimsVerifierFromEnv } from "@adapters/user-auth.ts";
import { createClient } from "@supabase/supabase-js";
import { handlePushSubscribe } from "./handler.ts";
import { createSubscribeStore } from "./store.ts";

const MAX_SUBSCRIPTIONS = 10;
const url = requireEnv("SUPABASE_URL");
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), options);

// verify_jwt is false (A-07): the JWT is optional; when present it is verified in code with getClaims (shared verifier). An invalid one means "no user".
const verifier = claimsVerifierFromEnv(createClient as never);
async function verifyUser(token: string): Promise<string | null> {
  const user = await verifier.verify(token).catch(() => null);
  return user === null ? null : user.userId;
}

const extraHosts = (Deno.env.get("PUSH_ENDPOINT_EXTRA_HOSTS") ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// per-IP limit in front of the handler (spec 15.2 T7), for signed-in and anonymous calls alike; the per-user cap is in notify_subscribe
const limit = {
  fn: "push-subscribe",
  perMinute: 20,
  salt: requireEnv("RATE_LIMIT_SALT"),
  incr: rpcIncr(admin),
};

Deno.serve(
  withIpRateLimit(
    (req) =>
      handlePushSubscribe(req, {
        store: createSubscribeStore(admin, MAX_SUBSCRIPTIONS),
        verifyUser,
        sendTestPush: (sub, payload) =>
          sendPush(
            sub,
            payload,
            { ttlSeconds: 300, topic: "test", urgency: "normal" },
            { env: loadPushEnv() },
          ),
        siteUrl: requireEnv("SITE_URL"),
        extraHosts,
        maxSubscriptions: MAX_SUBSCRIPTIONS,
        allowedOrigins: allowedOriginsFromEnv(),
      }),
    limit,
  ),
);
