import { assertEquals, assertRejects } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDigestStore } from "./digest-store.ts";

function fakeClient(responses: Record<string, unknown>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const data = responses[name];
      return Promise.resolve(
        data instanceof Error
          ? { data: null, error: { message: data.message } }
          : { data, error: null },
      );
    },
    from() {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: "r1",
                  status: "complete",
                  scan_date_local: "2026-10-15",
                  digests_created_at: null,
                },
                error: null,
              }),
          }),
        }),
      };
    },
  };
  return { calls, client: client as unknown as SupabaseClient };
}

Deno.test("store maps RPC rows and passes the documented parameter names", async () => {
  const { calls, client } = fakeClient({
    notify_digest_users: [
      {
        user_id: "u1",
        push_enabled: true,
        has_active_push: true,
        digest_modes: ["worldwide"],
        send_empty: false,
        holds_positions: true,
        has_discounts_push: true,
        has_portfolio_push: false,
      },
    ],
    notify_public_discount_candidates: [
      {
        episode_id: "e9",
        company_id: "c9",
        security_id: "s9",
        mode: "worldwide",
        rank: 4,
        yahoo_symbol: "ZZZ",
        exchange_code: "NMS",
        name: "Zeta",
        close: 2,
        currency: "USD",
        session_date: "2026-10-14",
        threshold_line: "-3",
        is_top10: true,
        reached_line4: false,
        category: null,
        conclusion: null,
        bankruptcy_risk: null,
        summary: "",
        eur_symbol: null,
        eur_status: null,
      },
    ],
    notify_insert_public_digest: "public-1",
    notify_discount_candidates: [
      {
        episode_id: "e1",
        company_id: "c1",
        security_id: "s1",
        mode: "us",
        rank: 3,
        yahoo_symbol: "AAA",
        exchange_code: "NMS",
        name: "Alpha",
        close: 1.5,
        currency: "USD",
        session_date: "2026-10-14",
        threshold_line: "-3",
        is_top10: true,
        reached_line4: false,
        category: "green",
        conclusion: null,
        bankruptcy_risk: null,
        summary: "s",
        eur_symbol: null,
        eur_status: null,
      },
    ],
    notify_portfolio_candidates: { premium: [], risks: [] },
    notify_insert_digest: "digest-1",
    notify_finish_digests: true,
  });
  const store = createDigestStore(client);
  assertEquals((await store.scanRun("r1"))?.scanDateLocal, "2026-10-15");
  const users = await store.getUsers();
  assertEquals(users[0]?.holdsPositions, true);
  assertEquals(users[0]?.modes, ["worldwide"]);
  assertEquals([users[0]?.hasDiscountsPush, users[0]?.hasPortfolioPush], [true, false]);
  const pub = await store.publicDiscountCandidates("r1");
  assertEquals([pub[0]?.episodeId, pub[0]?.rank], ["e9", 4]);
  assertEquals(calls.find((c) => c.name === "notify_public_discount_candidates")?.args, {
    p_scan_run: "r1",
  });
  const pubId = await store.insertPublicDigest({
    scanRunId: "r1",
    content: { kind: "discounts", scanDate: "2026-10-15", items: [] },
    hash: "h",
    reason: "cutoff",
    status: "skipped",
    skipReason: "empty",
    scanDate: "2026-10-15",
  });
  assertEquals(pubId, "public-1");
  assertEquals(calls.find((c) => c.name === "notify_insert_public_digest")?.args, {
    p_scan_run: "r1",
    p_content: { kind: "discounts", scanDate: "2026-10-15", items: [] },
    p_hash: "h",
    p_reason: "cutoff",
    p_status: "skipped",
    p_skip_reason: "empty",
    p_scan_date: "2026-10-15",
  });
  const rows = await store.discountCandidates("r1", "u1", true);
  assertEquals(rows[0]?.thresholdLine, "-3");
  assertEquals([rows[0]?.isTop10, rows[0]?.reachedLine4], [true, false]);
  assertEquals([rows[0]?.exchangeCode, rows[0]?.category], ["NMS", "green"]);
  assertEquals(calls.find((c) => c.name === "notify_discount_candidates")?.args, {
    p_scan_run: "r1",
    p_user: "u1",
    p_finished_only: true,
  });
  assertEquals(await store.portfolioCandidates("r1", "u1"), { premium: [], risks: [] });
  const id = await store.insertDigest({
    scanRunId: "r1",
    userId: "u1",
    kind: "discounts",
    content: { kind: "discounts", scanDate: "2026-10-15", items: [] },
    hash: "h",
    reason: "complete",
    status: "skipped",
    skipReason: "empty",
    items: [],
    channels: [],
    scanDate: "2026-10-15",
  });
  assertEquals(id, "digest-1");
  assertEquals(
    Object.keys(calls.find((c) => c.name === "notify_insert_digest")?.args ?? {}).sort(),
    [
      "p_channels",
      "p_content",
      "p_hash",
      "p_items",
      "p_kind",
      "p_reason",
      "p_scan_date",
      "p_scan_run",
      "p_skip_reason",
      "p_status",
      "p_user",
    ],
  );
  assertEquals(await store.finish("r1", "complete", { users: 1 }), true);
});

Deno.test("store surfaces RPC errors without parameters in the message", async () => {
  const { client } = fakeClient({ notify_digest_users: new Error("permission denied") });
  await assertRejects(
    () => createDigestStore(client).getUsers(),
    Error,
    "notify_digest_users failed: permission denied",
  );
});
