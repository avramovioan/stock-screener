import { assertEquals, assertRejects } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createEurStore, EurStoreError } from "./eur_store.ts";

/** Minimal chainable PostgREST fake: securities reads succeed, the broker_positions read returns `positions`. */
function fakeClient(positions: {
  data: unknown;
  error: { code?: string; message: string } | null;
}): SupabaseClient {
  const chain = (result: unknown, single?: unknown): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "not"]) q[m] = () => q;
    q.maybeSingle = () => Promise.resolve(single ?? result);
    // biome-ignore lint/suspicious/noThenProperty: PostgREST builders are awaitable
    q.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return q;
  };
  return {
    from: (table: string) =>
      table === "securities"
        ? chain({ data: [{ id: "s1" }], error: null }, { data: { company_id: "c1" }, error: null })
        : chain(positions),
  } as unknown as SupabaseClient;
}

Deno.test("heldIsins: an undefined table (42P01) means no held ISINs", async () => {
  const store = createEurStore(
    fakeClient({ data: null, error: { code: "42P01", message: "relation does not exist" } }),
  );
  assertEquals(await store.heldIsins("s1"), []);
});

Deno.test("heldIsins: any other read error is logged and rethrown", async () => {
  const store = createEurStore(
    fakeClient({ data: null, error: { code: "42501", message: "permission denied" } }),
  );
  const original = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    await assertRejects(() => store.heldIsins("s1"), EurStoreError);
  } finally {
    console.log = original;
  }
  assertEquals(logged.length, 1);
  assertEquals(JSON.parse(logged[0] as string), {
    event: "held_isins_read_failed",
    code: "42501",
    message: "permission denied",
  });
});

Deno.test("heldIsins: distinct ISINs on success", async () => {
  const store = createEurStore(
    fakeClient({ data: [{ isin: "A" }, { isin: "A" }, { isin: "B" }], error: null }),
  );
  assertEquals(await store.heldIsins("s1"), ["A", "B"]);
});
