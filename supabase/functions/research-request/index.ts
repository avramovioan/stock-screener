import { createServiceDb } from "@adapters/db.ts";
import { requireEnv } from "@adapters/env.ts";
import { corsHeaders, json as jsonResponse } from "@adapters/http.ts";
import { logError } from "@adapters/log.ts";
import { createAcceptedIpCounter, readCount, rpcIncr } from "@adapters/rate-limit.ts";
import { createSupabaseResearchStore } from "@adapters/research_store.ts";
import { parseResearchSettings } from "@adapters/research_types.ts";
import { handle, type PolicyDb } from "./handler.ts";

const { sb } = createServiceDb();
const store = createSupabaseResearchStore(sb);
const salt = requireEnv("RATE_LIMIT_SALT");
const siteOrigin = new URL(requireEnv("SITE_URL")).origin;

function fail(op: string, error: { message: string } | null): void {
  if (error) throw new Error(`research-request ${op}: ${error.message}`);
}

const db: PolicyDb = {
  async onList(scanRunId, securityId) {
    const { count, error } = await sb
      .from("todays_discounts")
      .select("id", { count: "exact", head: true })
      .eq("scan_run_id", scanRunId)
      .eq("security_id", securityId);
    fail("onList", error);
    return (count ?? 0) > 0;
  },
  async inFlight(securityId) {
    const asker = (v: unknown) => (v === "visitor" || v === "owner" || v === "system" ? v : null);
    const reports = await sb
      .from("research_reports")
      .select("started_at, created_at, usage")
      .eq("security_id", securityId)
      .in("status", ["queued", "running", "quota_deferred"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    fail("inFlight(reports)", reports.error);
    const report = reports.data as {
      started_at: string | null;
      created_at: string;
      usage: { source?: unknown } | null;
    } | null;
    if (report) {
      return {
        started_at: report.started_at ?? report.created_at,
        requested_by: asker(report.usage?.source),
      };
    }
    const jobs = await sb
      .from("scan_jobs")
      .select("created_at, payload")
      .eq("stage", "research")
      .in("status", ["queued", "leased", "failed"])
      .eq("payload->>security_id", securityId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    fail("inFlight(jobs)", jobs.error);
    const job = jobs.data as { created_at: string; payload: { source?: unknown } | null } | null;
    return job ? { started_at: job.created_at, requested_by: asker(job.payload?.source) } : null;
  },
  async lastCompleteAt(securityId) {
    const { data, error } = await sb
      .from("research_reports")
      .select("completed_at")
      .eq("security_id", securityId)
      .eq("status", "complete")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    fail("lastCompleteAt", error);
    return (data as { completed_at: string } | null)?.completed_at ?? null;
  },
  async lastFailed(securityId) {
    // reset and superseded failures are housekeeping, not a failed attempt: they never hold a visitor back
    const { data, error } = await sb
      .from("research_reports")
      .select("completed_at, updated_at, error")
      .eq("security_id", securityId)
      .eq("status", "failed")
      .or("error.is.null,error.not.in.(reset,superseded)")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    fail("lastFailed", error);
    const row = data as {
      completed_at: string | null;
      updated_at: string;
      error: string | null;
    } | null;
    return row ? { at: row.completed_at ?? row.updated_at, error: row.error } : null;
  },
  async quotaStatus() {
    const { data, error } = await sb.rpc("research_quota_status");
    fail("quotaStatus", error);
    const v = data as { available?: unknown; next_reset_at?: unknown } | null;
    return {
      available: v?.available === true,
      next_reset_at: typeof v?.next_reset_at === "string" ? v.next_reset_at : null,
    };
  },
  async audit(row) {
    const { error } = await sb.from("audit_events").insert(row);
    fail("audit", error);
  },
};

async function loadSettings() {
  const { data, error } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "research")
    .maybeSingle();
  fail("settings", error);
  return parseResearchSettings((data as { value: unknown } | null)?.value);
}

Deno.serve(async (req) => {
  // Preflight needs no settings: answer it before any database read.
  if (req.method === "OPTIONS") {
    const cors = corsHeaders(req.headers.get("origin"), [siteOrigin]);
    return new Response(null, {
      status: cors["access-control-allow-origin"] ? 204 : 403,
      headers: cors,
    });
  }
  // Settings are read per request: the per-IP allowance and the caps are owner-editable and must apply at once.
  let settings: Awaited<ReturnType<typeof loadSettings>>;
  try {
    settings = await loadSettings();
  } catch (e) {
    // fail closed: this action spends quota, so without the caps it does not run
    logError("research-request settings unavailable", e);
    return jsonResponse(
      { ok: false, reason: "try_later" },
      { status: 429, headers: corsHeaders(req.headers.get("origin"), [siteOrigin]) },
    );
  }
  return handle(req, {
    store,
    db,
    settings: async () => settings,
    counter: createAcceptedIpCounter({
      fn: "research-request",
      window: "hour",
      limit: settings.visitor_scans_per_hour_per_ip,
      salt,
      read: readCount(sb),
      incr: rpcIncr(sb),
    }),
    now: () => new Date(),
    siteOrigin,
    rateLimitSalt: salt,
  });
});
