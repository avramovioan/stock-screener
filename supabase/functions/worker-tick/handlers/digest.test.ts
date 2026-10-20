import { assertEquals } from "@std/assert";
import { handleDigest, seedDigest, withDigest } from "./digest.ts";

Deno.test("withDigest adds the digest stage, handler and seeder without touching the others", async () => {
  const merged = withDigest({ stages: ["fx", "news"], handlers: {}, seeders: {} });
  assertEquals(merged.stages, ["fx", "news", "digest"]);
  assertEquals(merged.handlers.digest, handleDigest);
  assertEquals(merged.seeders.digest, seedDigest);
  assertEquals(withDigest(merged).stages, ["fx", "news", "digest"]);
  const plan = await seedDigest(undefined as never);
  assertEquals(plan.keys, ["digest"]);
});
