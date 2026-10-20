import { corsHeaders, json, readJson, requireCronSecret } from "@adapters/http.ts";
import { authenticate, type UserVerifier } from "@adapters/user-auth.ts";
import { workerTick } from "./machine.ts";
import {
  ingestFixture,
  link,
  rekeyAll,
  type ServiceDeps,
  type ServiceResult,
  syncNow,
  testConnection,
  unlink,
} from "./service.ts";

export interface HandlerDeps {
  brokerDeps: ServiceDeps;
  verifier: UserVerifier;
  cronSecret: string;
  allowedOrigins?: string[];
}

const TICK_BUDGET_MS = 100_000;
const USER_ACTIONS = new Set(["link", "test", "sync", "unlink", "rekey"]);
const WORKER_ACTIONS = new Set(["tick", "rekey", "ingest_fixture"]);

/** Fixture mode needs FLEX_FIXTURE_MODE=1 AND a local Supabase URL (spec 7.12: mocks must never look like production data). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    // `kong` is the API gateway name inside the local edge-runtime container (SUPABASE_URL=http://kong:8000)
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "host.docker.internal" ||
      host === "kong"
    );
  } catch {
    return false;
  }
}

function respond(r: ServiceResult, cors: Record<string, string>): Response {
  return json(r.body, { status: r.status, headers: { ...cors, ...(r.headers ?? {}) } });
}

export async function handleRequest(req: Request, d: HandlerDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), d.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")
    return json(
      { error: "method_not_allowed" },
      { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } },
    );

  try {
    const workerMode = req.headers.has("x-cron-secret");
    if (workerMode) {
      const denied = await requireCronSecret(req, d.cronSecret);
      if (denied !== null) return denied;
    }
    const auth = workerMode ? null : await authenticate(req, d.verifier, cors);
    if (auth !== null && !auth.ok) return auth.response;

    const body = await readJson(req, workerMode ? 5_000_000 : 10_000);
    if (!body.ok) return body.response;
    const input =
      typeof body.value === "object" && body.value !== null
        ? (body.value as Record<string, unknown>)
        : {};
    const action = typeof input["action"] === "string" ? input["action"] : "";
    if (!(USER_ACTIONS.has(action) || WORKER_ACTIONS.has(action)))
      return json({ error: "unknown_action" }, { status: 400, headers: cors });

    if (workerMode) {
      if (!WORKER_ACTIONS.has(action))
        return json({ error: "unknown_action" }, { status: 400, headers: cors });
      if (action === "tick")
        return json(
          { ok: true, ...(await workerTick(d.brokerDeps, TICK_BUDGET_MS)) },
          { headers: cors },
        );
      if (action === "rekey") return respond(await rekeyAll(d.brokerDeps, null), cors);
      return respond(await ingestFixture(d.brokerDeps, input), cors);
    }

    if (!USER_ACTIONS.has(action))
      return json({ error: "forbidden" }, { status: 403, headers: cors });
    const userId = (auth as { ok: true; userId: string }).userId;
    switch (action) {
      case "link":
        return respond(await link(d.brokerDeps, userId, input), cors);
      case "test":
        return respond(await testConnection(d.brokerDeps, userId), cors);
      case "sync":
        return respond(await syncNow(d.brokerDeps, userId), cors);
      case "unlink":
        return respond(await unlink(d.brokerDeps, userId, input), cors);
      default:
        if (!(await d.brokerDeps.store.isAdmin(userId)))
          return json({ error: "forbidden" }, { status: 403, headers: cors });
        return respond(await rekeyAll(d.brokerDeps, userId), cors);
    }
  } catch (e) {
    d.brokerDeps.log("request_failed", { error: e instanceof Error ? e.name : "error" });
    return json({ error: "internal_error" }, { status: 500, headers: cors });
  }
}
