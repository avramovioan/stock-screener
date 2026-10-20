import { corsHeaders, json as jsonResponse } from "@adapters/http.ts";
import { logError } from "@adapters/log.ts";
import { clientIp, hashIp } from "@adapters/rate-limit.ts";
import type { ResearchSettings, ResearchStore } from "@adapters/research_types.ts";
import { requestVisitorResearch } from "../scan-control/actions/research_now.ts";

/** Visitor policy reads that the research store does not offer; the function binds them to Supabase. */
export interface PolicyDb {
  /** The security has a card in `todays_discounts` of the given (published) run. */
  onList(scanRunId: string, securityId: string): Promise<boolean>;
  /**
   * Any report of the security is queued, running or quota-deferred, or a research job for it is queued, leased or failed:
   * the scan's start (or queue) time and who asked (feed mapping); null when nothing is in flight.
   */
  inFlight(securityId: string): Promise<InFlight | null>;
  /** Completion time of the newest `complete` report. */
  lastCompleteAt(securityId: string): Promise<string | null>;
  /** The newest `failed` report that is not a reset or superseded one: when it failed and its error code. */
  lastFailed(securityId: string): Promise<{ at: string; error: string | null } | null>;
  /** `research_quota_status()`: false when every chain model, the Tavily credits or the visitor day cap are used up. */
  quotaStatus(): Promise<{ available: boolean; next_reset_at: string | null }>;
  audit(row: {
    actor_id: null;
    action: "research_request";
    target_type: "security";
    target_id: string;
    details: Record<string, unknown>;
  }): Promise<void>;
}

export interface InFlight {
  started_at: string | null;
  requested_by: "visitor" | "owner" | "system" | null;
}

export interface HandlerDeps {
  store: Pick<
    ResearchStore,
    "latestPublishedRun" | "acceptVisitorResearch" | "consumeQuota" | "quotaUsed"
  >;
  db: PolicyDb;
  settings(): Promise<ResearchSettings>;
  /** Accepted-only per-IP hour counter; both calls throw when the counter is unavailable. */
  counter: {
    check(req: Request): Promise<{ allowed: boolean; resetAtIso: string }>;
    commit(req: Request): Promise<void>;
  };
  now(): Date;
  /** The one browser origin allowed by CORS: the origin of SITE_URL. */
  siteOrigin: string;
  rateLimitSalt: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BUSY_RETRY_MINUTES = 15;

type Reason =
  | "invalid_input"
  | "not_on_list"
  | "in_flight"
  | "cooldown"
  | "retry_later"
  | "network_limit"
  | "no_quota"
  | "try_later";

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), [deps.siteOrigin]);
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    jsonResponse(body, { status, headers: { ...cors, ...extra } });
  const reject = (status: number, reason: Reason, nextAllowedAt?: string) =>
    reply(
      status,
      { ok: false, reason, ...(nextAllowedAt ? { next_allowed_at: nextAllowedAt } : {}) },
      nextAllowedAt
        ? {
            "retry-after": String(
              Math.max(1, Math.ceil((Date.parse(nextAllowedAt) - deps.now().getTime()) / 1000)),
            ),
          }
        : {},
    );

  const inFlight = (open: InFlight) =>
    reply(409, {
      ok: false,
      reason: "in_flight",
      started_at: open.started_at,
      requested_by: open.requested_by,
    });

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: cors["access-control-allow-origin"] ? 204 : 403,
      headers: cors,
    });
  }
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" });

  let securityId = "";
  try {
    const body = (await req.json()) as { security_id?: unknown } | null;
    if (typeof body?.security_id === "string") securityId = body.security_id;
  } catch {
    // falls through to invalid_input
  }
  if (!ID.test(securityId)) return reject(400, "invalid_input");

  try {
    const now = deps.now();
    const nowMs = now.getTime();
    const settings = await deps.settings();

    // 1. not_on_list: a card of the latest published run
    const run = await deps.store.latestPublishedRun();
    if (!run || !(await deps.db.onList(run.id, securityId))) return reject(404, "not_on_list");

    // 2. in_flight
    const open = await deps.db.inFlight(securityId);
    if (open) return inFlight(open);

    // 3. cooldown after a complete report
    const completeAt = await deps.db.lastCompleteAt(securityId);
    if (completeAt) {
      const next = Date.parse(completeAt) + settings.min_recheck_hours * 3_600_000;
      if (next > nowMs) return reject(429, "cooldown", new Date(next).toISOString());
    }

    // 4. retry_later after a failed report (a failure never starts the cooldown). A no_quota failure never blocks: the quota
    //    check below decides. A providers_busy failure waits the shorter busy window.
    const failed = await deps.db.lastFailed(securityId);
    if (failed && failed.error !== "no_quota") {
      const busy = (settings as { busy_retry_minutes?: unknown }).busy_retry_minutes;
      const minutes =
        failed.error === "providers_busy"
          ? typeof busy === "number" && busy > 0
            ? busy
            : DEFAULT_BUSY_RETRY_MINUTES
          : settings.visitor_retry_minutes;
      const next = Date.parse(failed.at) + minutes * 60_000;
      if (next > nowMs) return reject(429, "retry_later", new Date(next).toISOString());
    }

    // 5. network_limit: accepted requests only; the counter failing refuses the request (fail closed)
    let network: { allowed: boolean; resetAtIso: string };
    try {
      network = await deps.counter.check(req);
    } catch (e) {
      logError("research-request counter unavailable", e);
      return reject(429, "try_later");
    }
    if (!network.allowed) return reject(429, "network_limit", network.resetAtIso);

    // 6. no_quota: every chain model used up for the day, Tavily credits below 8, or the visitor day cap used up
    const quota = await deps.db.quotaStatus();
    if (!quota.available) return reject(429, "no_quota", quota.next_reset_at ?? undefined);

    // Accepted: count the network first (a failing counter spends nothing), then reserve the day's slot.
    try {
      await deps.counter.commit(req);
    } catch (e) {
      logError("research-request counter unavailable", e);
      return reject(429, "try_later");
    }
    if (
      !(await deps.store.consumeQuota("visitor", "scans", 1, "day", settings.visitor_scans_per_day))
    )
      return reject(429, "no_quota", nextUtcMidnight(now));

    const queued = await requestVisitorResearch(
      { store: deps.store, now: deps.now },
      { security_id: securityId },
    );
    if (!queued.ok) {
      // a request that won the race for this company between the check above and the atomic accept
      if (queued.error === "in_flight") return inFlight(queued);
      return reject(429, "try_later");
    }
    const reportId = queued.report_id;
    try {
      await deps.db.audit({
        actor_id: null,
        action: "research_request",
        target_type: "security",
        target_id: securityId,
        details: {
          source: "visitor",
          ip_hash: await hashIp(clientIp(req), deps.rateLimitSalt, nowMs),
          report_id: reportId,
        },
      });
    } catch (e) {
      logError("research-request audit failed", e);
    }
    return reply(200, { ok: true, report_id: reportId, started_at: queued.started_at });
  } catch (e) {
    logError("research-request failed", e);
    return reject(429, "try_later");
  }
}

function nextUtcMidnight(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}
