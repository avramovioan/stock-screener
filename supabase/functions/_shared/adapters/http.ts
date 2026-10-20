const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "authorization, apikey, content-type, x-client-info, x-cron-secret";

/** JSON response with a UTF-8 content type and `no-store` unless the caller overrides them. */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function originOf(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Browser origins allowed to call the functions: the public site (`SITE_URL`) followed by the
 * optional comma-separated `EXTRA_ALLOWED_ORIGINS` (for example a local dev server). Entries are
 * reduced to their origin; empty or invalid entries and duplicates are dropped.
 */
export function allowedOriginsFromEnv(): string[] {
  const entries = [
    Deno.env.get("SITE_URL") ?? "",
    ...(Deno.env.get("EXTRA_ALLOWED_ORIGINS") ?? "").split(","),
  ];
  const origins: string[] = [];
  for (const entry of entries) {
    const origin = originOf(entry);
    if (origin !== null && origin !== "null" && !origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
}

/** CORS headers; `access-control-allow-origin` is only set for an allowed origin. */
export function corsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[] = allowedOriginsFromEnv(),
): Record<string, string> {
  const headers: Record<string, string> = {
    vary: "Origin",
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": "86400",
  };
  if (origin !== null && allowedOrigins.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/** Constant-time string comparison: compares fixed-length SHA-256 digests, so length does not leak. */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  for (let i = 0; i < digestA.length; i++) {
    difference |= (digestA[i] ?? 0) ^ (digestB[i] ?? 0);
  }
  return difference === 0;
}

/**
 * Cron/worker authentication (spec 7.3): the `x-cron-secret` header must equal the configured
 * secret. Returns `null` when authorised, otherwise the error response to return. Fails closed
 * (500) when the secret is not configured.
 */
export async function requireCronSecret(req: Request, secret: string): Promise<Response | null> {
  const expected = secret.trim();
  if (expected.length === 0) {
    return json({ error: "server_misconfigured" }, { status: 500 });
  }
  const provided = (req.headers.get("x-cron-secret") ?? "").trim();
  return (await timingSafeEqualStrings(provided, expected))
    ? null
    : json({ error: "unauthorized" }, { status: 401 });
}

export type JsonBody =
  | { ok: true; value: unknown }
  | {
      ok: false;
      response: Response;
    };

/** Body text, or null when it exceeds `maxBytes` (checked on content-length first, then while streaming). */
async function readCappedBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads and parses a JSON request body (default limit 1 MB) without buffering more than the limit. */
export async function readJson(req: Request, maxBytes = 1_000_000): Promise<JsonBody> {
  const text = await readCappedBody(req, maxBytes);
  if (text === null) {
    return {
      ok: false,
      response: json({ error: "payload_too_large" }, { status: 413 }),
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: json({ error: "invalid_json" }, { status: 400 }),
    };
  }
}
