/** "Scan with AI": the public `research-request` Edge Function (spec 5.1). No secret leaves the browser. */

/** Why the server refused. `try_later` also stands for anything the browser could not read. */
export type ResearchRefusal =
  | "not_on_list"
  | "in_flight"
  | "cooldown"
  | "retry_later"
  | "network_limit"
  | "no_quota"
  | "budget_paused"
  | "try_later";

const REFUSALS: readonly string[] = [
  "not_on_list",
  "in_flight",
  "cooldown",
  "retry_later",
  "network_limit",
  "no_quota",
  "budget_paused",
  "try_later",
];

export type ResearchRequestResult =
  | { ok: true; reportId: string | null; startedAt: string }
  | {
      ok: false;
      reason: ResearchRefusal;
      nextAllowedAt: string | null;
      /** Only on `in_flight`: when the scan someone else started was queued or began, and who asked. */
      startedAt?: string | null;
      requestedBy?: Requester | null;
    };

export type Requester = "visitor" | "owner" | "system";

const TRY_LATER: ResearchRequestResult = { ok: false, reason: "try_later", nextAllowedAt: null };

/** Never throws: every failure is a refusal the card can show. */
export async function requestResearch(securityId: string): Promise<ResearchRequestResult> {
  const url = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
  let body: unknown;
  try {
    const res = await fetch(`${url}/functions/v1/research-request`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ security_id: securityId }),
    });
    body = await res.json();
  } catch {
    return TRY_LATER;
  }
  const out = body as {
    ok?: unknown;
    report_id?: unknown;
    started_at?: unknown;
    reason?: unknown;
    next_allowed_at?: unknown;
    requested_by?: unknown;
  } | null;
  // report_id is a string once the server has queued the report row; null stays accepted.
  if (out?.ok === true && typeof out.started_at === "string") {
    const reportId = typeof out.report_id === "string" ? out.report_id : null;
    return { ok: true, reportId, startedAt: out.started_at };
  }
  if (typeof out?.reason === "string" && REFUSALS.includes(out.reason)) {
    const refusal = {
      ok: false as const,
      reason: out.reason as ResearchRefusal,
      nextAllowedAt: typeof out.next_allowed_at === "string" ? out.next_allowed_at : null,
    };
    if (out.reason !== "in_flight") return refusal;
    return {
      ...refusal,
      startedAt: typeof out.started_at === "string" ? out.started_at : null,
      requestedBy:
        out.requested_by === "visitor" ||
        out.requested_by === "owner" ||
        out.requested_by === "system"
          ? out.requested_by
          : null,
    };
  }
  return TRY_LATER;
}
