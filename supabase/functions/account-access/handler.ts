import { corsHeaders, json as jsonResponse } from "@adapters/http.ts";
import { logError } from "@adapters/log.ts";

export interface Lookup {
  invited: boolean;
  resetPassword: boolean;
  userId: string | null;
}

export interface AccessStore {
  /** Invite row and auth user for an already normalised e-mail. */
  lookup(email: string): Promise<Lookup>;
  /** Creates a confirmed user; "exists" when somebody else created it first. */
  createUser(email: string, password: string): Promise<"ok" | "exists">;
  setPassword(userId: string, password: string): Promise<void>;
  clearReset(email: string): Promise<void>;
}

export interface HandlerDeps {
  store: AccessStore;
  /** Counts this call against the per-IP limits (10 a minute, 60 an hour); throws when the counter is unavailable. */
  limit(req: Request): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  allowedOrigins: readonly string[];
}

const MIN_PASSWORD = 12;
const MAX_PASSWORD = 72;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normaliseEmail = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
};

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), deps.allowedOrigins);
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    jsonResponse(body, { status, headers: { ...cors, ...extra } });

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: cors["access-control-allow-origin"] ? 204 : 403,
      headers: cors,
    });
  }
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" });

  try {
    const verdict = await deps.limit(req).catch(() => ({ allowed: true, retryAfterSeconds: 0 }));
    if (!verdict.allowed) {
      return reply(
        429,
        { ok: false, reason: "rate_limited", retry_after_seconds: verdict.retryAfterSeconds },
        { "retry-after": String(verdict.retryAfterSeconds) },
      );
    }

    let body: { action?: unknown; email?: unknown; password?: unknown } = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === "object") body = parsed;
    } catch {
      // an unreadable body behaves like a missing e-mail
    }
    const email = normaliseEmail(body.email);

    if (body.action === "check") {
      if (email === null) return reply(200, { status: "not_possible" });
      const found = await deps.store.lookup(email);
      if (!found.invited) return reply(200, { status: "not_possible" });
      const status = found.userId === null || found.resetPassword ? "create_password" : "sign_in";
      return reply(200, { status });
    }

    if (body.action === "set_password") {
      const password = body.password;
      if (
        typeof password !== "string" ||
        password.length < MIN_PASSWORD ||
        password.length > MAX_PASSWORD
      ) {
        return reply(400, { ok: false, reason: "weak_password" });
      }
      const refuse = () => reply(403, { ok: false, reason: "not_possible" });
      if (email === null) return refuse();
      const found = await deps.store.lookup(email);
      if (!found.invited) return refuse();
      if (found.userId === null) {
        if ((await deps.store.createUser(email, password)) === "exists") return refuse();
      } else if (found.resetPassword) {
        await deps.store.setPassword(found.userId, password);
      } else {
        return refuse();
      }
      if (found.resetPassword) await deps.store.clearReset(email);
      return reply(200, { ok: true });
    }

    return reply(400, { ok: false, error: "invalid_action" });
  } catch (e) {
    logError("account-access failed", e instanceof Error ? e.name : "error");
    return reply(500, { ok: false, error: "server_error" });
  }
}
