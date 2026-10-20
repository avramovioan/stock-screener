import { corsHeaders, json as jsonResponse } from "@adapters/http.ts";
import { logError } from "@adapters/log.ts";
import { checkRate } from "./ratelimit.ts";
import { BusyError, type Deps, getChart, getQuotes, getSearch } from "./service.ts";
import { normalizeQuery, normalizeSymbol, parseSymbols } from "./validate.ts";

export interface HandlerDeps extends Deps {
  /** The one browser origin allowed by CORS: the origin of SITE_URL. */
  siteOrigin: string;
  rateLimitSalt: string;
}

/** P0's JSON helper (UTF-8, no-store) with the status first, as used throughout this file. */
function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return jsonResponse(body, { status, headers });
}

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  // P0 corsHeaders: Vary, allowed methods and headers always; access-control-allow-origin only for the site origin.
  const cors = corsHeaders(req.headers.get("origin"), [deps.siteOrigin]);

  if (req.method === "OPTIONS") {
    if (!cors["access-control-allow-origin"])
      return new Response(null, { status: 403, headers: cors });
    return new Response(null, { status: 204, headers: cors });
  }

  const nowMs = deps.now();
  try {
    // A broken limiter must not take the public site down: fail open, never log the IP.
    const rate = await checkRate(deps.store, req, deps.rateLimitSalt, "quotes", nowMs).catch(
      (e) => {
        logError("rate limiter unavailable", e);
        return { allowed: true, retryAfterSec: 1 };
      },
    );
    if (!rate.allowed) {
      return json(
        429,
        { error: "rate limit exceeded" },
        { ...cors, "Retry-After": String(rate.retryAfterSec) },
      );
    }

    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*\/quotes(?=\/|$)/, "") || "/";
    const iso = (ms: number) => new Date(ms).toISOString();

    if (route === "/search") {
      if (req.method !== "GET") return json(405, { error: "method not allowed" }, cors);
      const q = normalizeQuery(url.searchParams.get("q"));
      if (q === null) return json(400, { error: "q must be 2-40 characters" }, cors);
      const r = await getSearch(deps, q);
      return json(200, { hits: r.value, fetchedAt: iso(r.fetchedAt), stale: r.stale }, cors);
    }

    if (route === "/quote") {
      if (req.method !== "POST") return json(405, { error: "method not allowed" }, cors);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid JSON" }, cors);
      }
      const parsed = parseSymbols(body);
      if (!parsed.ok) return json(400, { error: parsed.error }, cors);
      const r = await getQuotes(deps, parsed.symbols);
      return json(
        200,
        {
          quotes: r.quotes,
          missing: r.missing,
          unavailable: r.unavailable,
          fetchedAt: iso(deps.now()),
          stale: r.stale,
        },
        cors,
      );
    }

    if (route === "/chart") {
      if (req.method !== "GET") return json(405, { error: "method not allowed" }, cors);
      const symbol = normalizeSymbol(url.searchParams.get("symbol"));
      if (symbol === null) return json(400, { error: "invalid symbol" }, cors);
      const r = await getChart(deps, symbol);
      return json(200, { ...r.value, fetchedAt: iso(r.fetchedAt), stale: r.stale }, cors);
    }

    return json(404, { error: "not found" }, cors);
  } catch (e) {
    if (e instanceof BusyError)
      return json(503, { error: "busy, retry shortly" }, { ...cors, "Retry-After": "2" });
    logError("quotes failed", e);
    return json(502, { error: "upstream unavailable" }, cors);
  }
}
