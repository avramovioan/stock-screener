import { assertEquals } from "@std/assert";
import { handleNotifyDispatch } from "./handler.ts";

const run = () => Promise.resolve({ claimed: 2, processed: 2, errors: 0 });
const deps = { cronSecret: "s3cret", run };

Deno.test("rejects calls without the cron secret", async () => {
  const res = await handleNotifyDispatch(new Request("http://x/", { method: "POST" }), deps);
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "unauthorized");
});

Deno.test("fails closed when no secret is configured", async () => {
  const res = await handleNotifyDispatch(
    new Request("http://x/", { method: "POST", headers: { "x-cron-secret": "" } }),
    { ...deps, cronSecret: "" },
  );
  assertEquals(res.status, 500);
});

Deno.test("POST with the secret runs one dispatch pass and reports counts only", async () => {
  const res = await handleNotifyDispatch(
    new Request("http://x/", {
      method: "POST",
      headers: { "x-cron-secret": "s3cret" },
      body: '{"action":"tick"}',
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, claimed: 2, processed: 2, errors: 0 });
});

Deno.test("only POST is allowed", async () => {
  const res = await handleNotifyDispatch(
    new Request("http://x/", { method: "GET", headers: { "x-cron-secret": "s3cret" } }),
    deps,
  );
  assertEquals(res.status, 405);
});
