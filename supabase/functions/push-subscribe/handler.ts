import { base64UrlDecode } from "@adapters/encoding.ts";
import { corsHeaders, json, readJson } from "@adapters/http.ts";
import { isAllowedPushEndpoint, type PushResult, type PushTarget } from "@adapters/push.ts";

export interface Topics {
  discounts: boolean;
  portfolio: boolean;
}

export type TestClaim =
  | { kind: "ok"; target: PushTarget & { id: string } }
  | { kind: "rate_limited" }
  | { kind: "not_found" };

export interface SubscribeStore {
  /** user id null = an anonymous device (portfolio is already forced off by the handler) */
  upsert(
    userId: string | null,
    sub: { endpoint: string; p256dh: string; auth: string; userAgent: string | null },
    topics: Topics,
  ): Promise<"ok" | "too_many">;
  /** re-binds the row to the user (or to nobody) and sets the topics; false when no active row has that endpoint */
  update(userId: string | null, endpoint: string, topics: Topics): Promise<boolean>;
  /** the topics of an active subscription, or null when the endpoint is not subscribed */
  status(endpoint: string): Promise<Topics | null>;
  remove(endpoint: string): Promise<void>;
  /** at most one test push per endpoint per minute; returns the target on success */
  claimTest(endpoint: string): Promise<TestClaim>;
  mark(id: string, outcome: "success" | "failure" | "gone"): Promise<void>;
}

export interface PushSubscribeDeps {
  store: SubscribeStore;
  /** verifies the bearer JWT (getClaims against the project JWKS) and returns the user id, or null */
  verifyUser(token: string): Promise<string | null>;
  sendTestPush(sub: PushTarget, payloadJson: string): Promise<PushResult>;
  siteUrl: string;
  extraHosts: string[];
  maxSubscriptions: number;
  allowedOrigins: string[];
}

type Parsed =
  | { endpoint: string; p256dh: string; auth: string }
  | "invalid_endpoint"
  | "invalid_keys";

function parseSubscription(value: unknown, extraHosts: string[]): Parsed {
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = sub?.endpoint;
  if (
    typeof endpoint !== "string" ||
    endpoint.length > 2048 ||
    !isAllowedPushEndpoint(endpoint, extraHosts)
  ) {
    return "invalid_endpoint";
  }
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return "invalid_keys";
  try {
    const key = base64UrlDecode(p256dh);
    if (key.length !== 65 || key[0] !== 4) return "invalid_keys";
    if (base64UrlDecode(auth).length !== 16) return "invalid_keys";
  } catch {
    return "invalid_keys";
  }
  return { endpoint, p256dh, auth };
}

/** `topics` must be `{ discounts: boolean, portfolio: boolean }`; absent means the defaults (discounts on, portfolio off). */
function parseTopics(value: unknown, required: boolean): Topics | "invalid_topics" {
  if (value === undefined && !required) return { discounts: true, portfolio: false };
  const t = value as { discounts?: unknown; portfolio?: unknown } | null;
  if (
    typeof t !== "object" ||
    t === null ||
    typeof t.discounts !== "boolean" ||
    typeof t.portfolio !== "boolean"
  ) {
    return "invalid_topics";
  }
  return { discounts: t.discounts, portfolio: t.portfolio };
}

function validEndpoint(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}

export async function handlePushSubscribe(
  req: Request,
  deps: PushSubscribeDeps,
): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), deps.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")
    return json(
      { error: "method_not_allowed" },
      { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } },
    );
  const reply = (body: unknown, status = 200) => json(body, { status, headers: cors });

  // The JWT is optional: no header, an invalid token or a verifier failure all mean "no user".
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  let userId: string | null = null;
  if (bearer !== undefined) {
    try {
      userId = await deps.verifyUser(bearer.trim());
    } catch {
      userId = null;
    }
  }

  const body = await readJson(req, 8_000);
  if (!body.ok) return reply(await body.response.json(), body.response.status);
  const input = body.value as {
    action?: unknown;
    subscription?: unknown;
    endpoint?: unknown;
    topics?: unknown;
  } | null;

  // A row without a user can never hold the portfolio topic (holdings belong to accounts).
  const effective = (t: Topics): Topics => ({
    discounts: t.discounts,
    portfolio: t.portfolio && userId !== null,
  });

  switch (input?.action) {
    case "subscribe": {
      const parsed = parseSubscription(input.subscription, deps.extraHosts);
      if (typeof parsed === "string") return reply({ error: parsed }, 400);
      const requested = parseTopics(input.topics, false);
      if (requested === "invalid_topics") return reply({ error: requested }, 400);
      const topics = effective(requested);
      const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 200) || null;
      const result = await deps.store.upsert(userId, { ...parsed, userAgent }, topics);
      return result === "too_many"
        ? reply({ error: "too_many_subscriptions" }, 409)
        : reply({ ok: true, topics });
    }
    case "update": {
      if (!validEndpoint(input.endpoint)) return reply({ error: "invalid_endpoint" }, 400);
      const requested = parseTopics(input.topics, true);
      if (requested === "invalid_topics") return reply({ error: requested }, 400);
      const topics = effective(requested);
      const found = await deps.store.update(userId, input.endpoint, topics);
      return found ? reply({ ok: true, topics }) : reply({ error: "not_found" }, 404);
    }
    case "status": {
      if (!validEndpoint(input.endpoint)) return reply({ error: "invalid_endpoint" }, 400);
      const topics = await deps.store.status(input.endpoint);
      return reply({ subscribed: topics !== null, topics });
    }
    case "unsubscribe": {
      if (!validEndpoint(input.endpoint)) return reply({ error: "invalid_endpoint" }, 400);
      await deps.store.remove(input.endpoint);
      return reply({ ok: true });
    }
    case "test": {
      if (!validEndpoint(input.endpoint)) return reply({ error: "invalid_endpoint" }, 400);
      const claim = await deps.store.claimTest(input.endpoint);
      if (claim.kind === "rate_limited") return reply({ error: "rate_limited" }, 429);
      if (claim.kind === "not_found") return reply({ error: "not_found" }, 404);
      const payload = JSON.stringify({
        title: "Test notification",
        body: "Push is working on this device.",
        url: `${deps.siteUrl.replace(/\/+$/, "")}/profile/notifications`,
        tag: "test",
      });
      const { target } = claim;
      const result = await deps.sendTestPush(
        { endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth },
        payload,
      );
      if (result.ok) {
        await deps.store.mark(target.id, "success");
        return reply({ ok: true, sent: 1, failed: 0 });
      }
      await deps.store.mark(target.id, result.kind === "gone" ? "gone" : "failure");
      return reply({ ok: true, sent: 0, failed: 1 });
    }
    default:
      return reply({ error: "unknown_action" }, 400);
  }
}
