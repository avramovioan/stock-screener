import { createServiceClient } from "@adapters/db.ts";
import { json } from "@adapters/http.ts";
import { handleHealth } from "./handler.ts";
import { healthDetail } from "./status.ts";

/** P0 liveness answer, extended in P1 with public.scan_status() and the database size. */
Deno.serve(async (req) => {
  const base = handleHealth(req);
  if (req.method !== "GET") return base;
  const detail = await healthDetail(createServiceClient());
  const body = (await base.json()) as Record<string, unknown>;
  return json(
    { ...body, ...detail, ok: body["ok"] === true && detail.ok },
    { status: detail.ok ? 200 : 503, headers: base.headers },
  );
});
