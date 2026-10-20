import { createServiceDb } from "@adapters/db.ts";
import { requireEnv } from "@adapters/env.ts";
import { allowedOriginsFromEnv } from "@adapters/http.ts";
import { createAcceptedIpCounter, readCount, rpcIncr } from "@adapters/rate-limit.ts";
import { handle } from "./handler.ts";
import { createAccessStore } from "./store.ts";

const { sb } = createServiceDb();
const salt = requireEnv("RATE_LIMIT_SALT");
const counter = (window: "minute" | "hour", limit: number) =>
  createAcceptedIpCounter({
    fn: "account-access",
    window,
    limit,
    salt,
    read: readCount(sb),
    incr: rpcIncr(sb),
  });
const perMinute = counter("minute", 10);
const perHour = counter("hour", 60);

Deno.serve((req) =>
  handle(req, {
    store: createAccessStore(sb),
    // every call counts (not only accepted ones): the e-mail check is the thing worth throttling
    async limit(r) {
      const [m, h] = await Promise.all([perMinute.check(r), perHour.check(r)]);
      if (!m.allowed || !h.allowed) {
        const reset = Math.max(
          ...[m, h].filter((x) => !x.allowed).map((x) => Date.parse(x.resetAtIso)),
        );
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((reset - Date.now()) / 1000)),
        };
      }
      await Promise.all([perMinute.commit(r), perHour.commit(r)]);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    allowedOrigins: allowedOriginsFromEnv(),
  }),
);
