import { corsHeaders, json } from "@adapters/http.ts";
import { CORE_VERSION } from "@core/mod.ts";

export function handleHealth(req: Request): Response {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") {
    return json(
      { error: "method_not_allowed" },
      { status: 405, headers: { ...cors, allow: "GET, OPTIONS" } },
    );
  }
  return json(
    { ok: true, version: CORE_VERSION, time: new Date().toISOString() },
    { headers: cors },
  );
}
