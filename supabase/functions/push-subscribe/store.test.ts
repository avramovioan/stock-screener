import { assertEquals, assertRejects } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSubscribeStore } from "./store.ts";

function fakeClient(responses: Record<string, unknown>, rows: unknown = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const filters: [string, unknown][] = [];
  const query = {
    select: () => query,
    delete: () => ({
      eq: (col: string, value: unknown) => {
        filters.push([col, value]);
        return Promise.resolve({ error: null });
      },
    }),
    eq: (col: string, value: unknown) => {
      filters.push([col, value]);
      return query;
    },
    is: (col: string, value: unknown) => {
      filters.push([`${col} is`, value]);
      return query;
    },
    maybeSingle: () => Promise.resolve({ data: rows, error: null }),
  };
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
    from: () => query,
  };
  return { calls, filters, client: client as unknown as SupabaseClient };
}

Deno.test("upsert passes a null user for an anonymous device and the topics", async () => {
  const { calls, client } = fakeClient({ notify_subscribe: "ok" });
  const store = createSubscribeStore(client, 10);
  const r = await store.upsert(
    null,
    { endpoint: "https://e/1", p256dh: "k", auth: "a", userAgent: null },
    { discounts: true, portfolio: false },
  );
  assertEquals(r, "ok");
  assertEquals(calls[0]?.args, {
    p_user: null,
    p_endpoint: "https://e/1",
    p_p256dh: "k",
    p_auth: "a",
    p_user_agent: null,
    p_max: 10,
    p_discounts: true,
    p_portfolio: false,
  });
  const full = fakeClient({ notify_subscribe: "too_many" });
  assertEquals(
    await createSubscribeStore(full.client, 1).upsert(
      "u",
      { endpoint: "e", p256dh: "k", auth: "a", userAgent: null },
      { discounts: true, portfolio: true },
    ),
    "too_many",
  );
});

Deno.test("update maps the boolean answer; claimTest maps the three statuses", async () => {
  const upd = fakeClient({ notify_update_subscription: true });
  assertEquals(
    await createSubscribeStore(upd.client, 10).update("u", "e", {
      discounts: false,
      portfolio: true,
    }),
    true,
  );
  assertEquals(upd.calls[0]?.args, {
    p_user: "u",
    p_endpoint: "e",
    p_discounts: false,
    p_portfolio: true,
  });
  const ok = fakeClient({
    notify_claim_endpoint_test: { status: "ok", id: "i", endpoint: "e", p256dh: "k", auth: "a" },
  });
  assertEquals(await createSubscribeStore(ok.client, 10).claimTest("e"), {
    kind: "ok",
    target: { id: "i", endpoint: "e", p256dh: "k", auth: "a" },
  });
  for (const status of ["rate_limited", "not_found"] as const) {
    const c = fakeClient({ notify_claim_endpoint_test: { status } });
    assertEquals(await createSubscribeStore(c.client, 10).claimTest("e"), { kind: status });
  }
});

Deno.test("status reads the topics of an active subscription; remove deletes by endpoint only", async () => {
  const { client, filters } = fakeClient({}, { topic_discounts: true, topic_portfolio: false });
  const store = createSubscribeStore(client, 10);
  assertEquals(await store.status("e"), { discounts: true, portfolio: false });
  assertEquals(filters, [
    ["endpoint", "e"],
    ["revoked_at is", null],
  ]);
  filters.length = 0;
  await store.remove("e");
  assertEquals(filters, [["endpoint", "e"]]);
  assertEquals(await createSubscribeStore(fakeClient({}, null).client, 10).status("e"), null);
});

Deno.test("RPC errors surface with the function name", async () => {
  const { client } = fakeClient({ notify_subscribe: new Error("boom") });
  await assertRejects(
    () =>
      createSubscribeStore(client, 10).upsert(
        null,
        { endpoint: "e", p256dh: "k", auth: "a", userAgent: null },
        { discounts: true, portfolio: false },
      ),
    Error,
    "notify_subscribe failed: boom",
  );
});
