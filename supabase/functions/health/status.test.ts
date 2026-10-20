import { assertEquals } from "@std/assert";
import { DB_SIZE_WARN_BYTES, shapeHealth } from "./status.ts";

Deno.test("shapeHealth reports the scan status and the size in MB", () => {
  const h = shapeHealth(
    { data: { last_attempted: null }, error: null },
    { data: 50 * 1024 * 1024, error: null },
  );
  assertEquals(h, {
    ok: true,
    scan: { last_attempted: null },
    db: { size_bytes: 52428800, size_mb: 50, warn: false },
  });
});

Deno.test("the size alarm triggers above 400 MB", () => {
  assertEquals(
    shapeHealth({ data: null, error: null }, { data: DB_SIZE_WARN_BYTES + 1, error: null }).db.warn,
    true,
  );
  assertEquals(
    shapeHealth({ data: null, error: null }, { data: DB_SIZE_WARN_BYTES, error: null }).db.warn,
    false,
  );
});

Deno.test("an RPC error makes ok false and never throws", () => {
  const h = shapeHealth({ data: null, error: { message: "x" } }, { data: null, error: null });
  assertEquals([h.ok, h.db.size_bytes], [false, null]);
});

Deno.test("PGRST106 on the app schema answers app_schema_not_exposed", () => {
  const h = shapeHealth(
    { data: null, error: null },
    {
      data: null,
      error: { code: "PGRST106", message: "The schema must be one of the following: public" },
    },
  );
  assertEquals([h.ok, h.error], [false, "app_schema_not_exposed"]);
});
