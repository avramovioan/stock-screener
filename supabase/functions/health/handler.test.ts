import { CORE_VERSION } from "@core/mod.ts";
import { assert, assertEquals } from "@std/assert";
import { handleHealth } from "./handler.ts";

Deno.test("GET returns ok, the core version and an ISO time", async () => {
  const response = handleHealth(new Request("http://localhost/health"));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.version, CORE_VERSION);
  assert(!Number.isNaN(Date.parse(body.time)));
});

Deno.test("OPTIONS answers the CORS preflight with 204", async () => {
  const response = handleHealth(new Request("http://localhost/health", { method: "OPTIONS" }));
  assertEquals(response.status, 204);
  await response.body?.cancel();
});

Deno.test("other methods are rejected with 405", async () => {
  const response = handleHealth(new Request("http://localhost/health", { method: "POST" }));
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET, OPTIONS");
  await response.body?.cancel();
});
