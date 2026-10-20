import { createServiceDb } from "@adapters/db.ts";
import { corsHeaders, json, requireCronSecret } from "@adapters/http.ts";
import { logError } from "@adapters/log.ts";
import { type Actor, ControlError, execute } from "./actions.ts";
import { parseRequest } from "./validate.ts";

/**
 * Operator endpoint (7.12). Authenticated by the shared secret header (scripts, tools) or by the JWT of an admin user (interactive use,
 * verified in code with getClaims because verify_jwt = false, A-07). Every state change writes an audit_events row.
 */
async function authenticate(
  req: Request,
  db: ReturnType<typeof createServiceDb>,
): Promise<Actor | Response> {
  const secret = Deno.env.get("CRON_SHARED_SECRET") ?? "";
  if (req.headers.get("x-cron-secret") !== null && (await requireCronSecret(req, secret)) === null)
    return { via: "secret", userId: null };
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (token === "") return json({ error: "unauthorized" }, { status: 401 });
  const { data, error } = await db.sb.auth.getClaims(token);
  const sub = data?.claims?.sub;
  if (error || typeof sub !== "string") return json({ error: "unauthorized" }, { status: 401 });
  const { data: profile } = await db.sb
    .from("profiles")
    .select("is_admin")
    .eq("user_id", sub)
    .maybeSingle();
  if (profile?.is_admin !== true) return json({ error: "forbidden" }, { status: 403 });
  return { via: "jwt", userId: sub };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")
    return json({ error: "method_not_allowed" }, { status: 405, headers: cors });
  const db = createServiceDb();
  const actor = await authenticate(req, db);
  if (actor instanceof Response) return actor;

  const parsed = parseRequest(await req.json().catch(() => null));
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400, headers: cors });
  try {
    const result = await execute(parsed, {
      db,
      actor,
      allowFixtures: Deno.env.get("ALLOW_FIXTURE_PROVIDERS") === "1",
    });
    return json({ ok: true, ...result }, { headers: cors });
  } catch (e) {
    if (e instanceof ControlError)
      return json({ error: e.message }, { status: e.status, headers: cors });
    logError("scan-control failed", e);
    return json({ error: "internal_error" }, { status: 500, headers: cors });
  }
});
