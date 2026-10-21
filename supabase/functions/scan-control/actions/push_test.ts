import type { SupabaseClient } from "@supabase/supabase-js";
import type { PushResult, PushTarget } from "../../_shared/adapters/push.ts";

export type PushTestResult =
  | { ok: false; reason: "server_keys"; problem: string }
  | { ok: false; reason: "rate_limited"; retry_after_seconds: number }
  | {
      ok: true;
      devices: number;
      sent: number;
      failed: number;
      gone: number;
      reasons: { server_keys?: number; rejected?: Record<string, number>; network?: number };
    };

/**
 * Operator action `push_test`: one test push (the payload of push-subscribe's test) to every active subscription, at most once per five
 * minutes. Gone devices are revoked like the dispatcher does. The answer has counts only, never an endpoint.
 */
export async function pushTest(deps: {
  sb: Pick<SupabaseClient, "rpc">;
  siteUrl: string;
  checkConfig(): Promise<{ configured: boolean; problem: string | null }>;
  sendPush(sub: PushTarget, payloadJson: string): Promise<PushResult>;
}): Promise<PushTestResult> {
  const config = await deps.checkConfig();
  if (!config.configured)
    return { ok: false, reason: "server_keys", problem: config.problem ?? "unknown" };

  const claim = await deps.sb.rpc("push_claim_test");
  if (claim.error) throw new Error(`push_claim_failed: ${claim.error.message}`);
  const c = claim.data as {
    status: "ok" | "rate_limited";
    retry_after_seconds?: number;
    devices?: Array<PushTarget & { id: string }>;
  };
  if (c.status === "rate_limited")
    return { ok: false, reason: "rate_limited", retry_after_seconds: c.retry_after_seconds ?? 300 };

  const payload = JSON.stringify({
    title: "Test notification",
    body: "Push is working on this device.",
    url: `${deps.siteUrl.replace(/\/+$/, "")}/profile/notifications`,
    tag: "test",
  });
  const devices = c.devices ?? [];
  let sent = 0;
  let failed = 0;
  let gone = 0;
  let serverKeys = 0;
  let network = 0;
  const rejected: Record<string, number> = {};
  const mark = async (id: string, outcome: "success" | "failure" | "gone") => {
    const { error } = await deps.sb.rpc("notify_mark_subscription", {
      p_id: id,
      p_outcome: outcome,
    });
    if (error) throw new Error(`push_mark_failed: ${error.message}`);
  };
  for (const d of devices) {
    let result: PushResult;
    try {
      result = await deps.sendPush(
        { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth },
        payload,
      );
    } catch {
      serverKeys++;
      failed++;
      await mark(d.id, "failure");
      continue;
    }
    if (result.ok) {
      sent++;
      await mark(d.id, "success");
    } else if (result.kind === "gone") {
      gone++;
      await mark(d.id, "gone");
    } else {
      failed++;
      if (result.kind === "network") network++;
      else {
        const key = String(result.status ?? "unknown");
        rejected[key] = (rejected[key] ?? 0) + 1;
      }
      await mark(d.id, "failure");
    }
  }
  const reasons: { server_keys?: number; rejected?: Record<string, number>; network?: number } = {};
  if (serverKeys > 0) reasons.server_keys = serverKeys;
  if (Object.keys(rejected).length > 0) reasons.rejected = rejected;
  if (network > 0) reasons.network = network;
  return { ok: true, devices: devices.length, sent, failed, gone, reasons };
}
