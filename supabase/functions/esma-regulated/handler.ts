import { corsHeaders, json as jsonResponse } from "@adapters/http.ts";
import { logError } from "@adapters/log.ts";
import { authenticate, type UserVerifier } from "@adapters/user-auth.ts";
import {
  ESMA_MANUAL_URLS,
  ESMA_SEARCH_URL,
  type EsmaDoc,
  firdsQuery,
  firdsSolrUrl,
  firstFirdsMatch,
  hasExchangeSegment,
  isValidIsin,
  normalizeIsin,
  parseEsmaDocs,
  pickRegulatedSegments,
  type RegulatedSegment,
  venuesQueryByLei,
  venuesQueryByMic,
  venuesSolrUrlByLei,
  venuesSolrUrlByMic,
} from "@core/esma.ts";
import { findEuExchange } from "@core/eu-exchanges.ts";
import type { CacheStore } from "../quotes/cache.ts";
import { checkRate } from "../quotes/ratelimit.ts";

export type Verdict = "regulated" | "not-offered" | "no-regulated-segment" | "not-in-esma";
export type Source = "solr" | "search";

export interface RegulatedResult {
  isin: string;
  mic: string;
  exchangeName: string;
  verdict: Verdict;
  matchedSegment: RegulatedSegment | null;
  instrumentName: string | null;
  regulatedSegments: RegulatedSegment[];
  checkedSegments: string[];
  checkedAt: string;
  /** "solr": exact-field select endpoint; "search": the slower doMainSearch fallback. */
  source: Source;
}

export interface HandlerDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  store: CacheStore;
  verifier: UserVerifier;
  now: () => number;
  /** The one browser origin allowed by CORS: the origin of SITE_URL. */
  siteOrigin: string;
  rateLimitSalt: string;
}

/** ESMA answered with something that is not register JSON (captcha/HTML page, error, timeout). */
class EsmaUnavailableError extends Error {}

const SOLR_TIMEOUT_MS = 8_000;
const SEARCH_TIMEOUT_MS = 20_000;
/** Total wall-clock budget, below the edge function limit. */
const BUDGET_MS = 45_000;

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return jsonResponse(body, { status, headers });
}

async function request(
  deps: HandlerDeps,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<EsmaDoc[]> {
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new EsmaUnavailableError("request failed");
  }
  if (!res.ok) throw new EsmaUnavailableError(`HTTP ${res.status}`);
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new EsmaUnavailableError("body unreadable");
  }
  const docs = parseEsmaDocs(text);
  if (docs === null) throw new EsmaUnavailableError("not register JSON");
  return docs;
}

/** Runs ESMA lookups: the Solr select endpoint first, doMainSearch only after a Solr failure. */
class EsmaClient {
  /** True once any request went through doMainSearch. */
  usedSearch = false;
  private solrDown = false;
  private readonly deadline: number;

  constructor(
    private readonly deps: HandlerDeps,
    startMs: number,
  ) {
    this.deadline = startMs + BUDGET_MS;
  }

  get source(): Source {
    return this.usedSearch ? "search" : "solr";
  }

  private solr(url: string): Promise<EsmaDoc[]> {
    return request(
      this.deps,
      url,
      { method: "GET", headers: { accept: "application/json" } },
      SOLR_TIMEOUT_MS,
    );
  }

  search(body: Record<string, unknown>): Promise<EsmaDoc[]> {
    const remaining = this.deadline - this.deps.now();
    if (remaining <= 0) throw new EsmaUnavailableError("time budget spent");
    this.usedSearch = true;
    return request(
      this.deps,
      ESMA_SEARCH_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      },
      Math.min(SEARCH_TIMEOUT_MS, remaining),
    );
  }

  /** Venues docs for the exchange: one request per LEI (or by MIC when it has none). */
  async venues(leis: readonly string[], mic: string): Promise<EsmaDoc[]> {
    const jobs = leis.length > 0 ? leis : [null];
    const out: EsmaDoc[] = [];
    for (const lei of jobs) {
      const solrUrl = lei === null ? venuesSolrUrlByMic(mic) : venuesSolrUrlByLei(lei);
      const body = lei === null ? venuesQueryByMic(mic) : venuesQueryByLei(lei);
      out.push(...(await this.solrOrSearch(solrUrl, body)));
    }
    return out;
  }

  private async solrOrSearch(url: string, body: Record<string, unknown>): Promise<EsmaDoc[]> {
    if (!this.solrDown) {
      try {
        return await this.solr(url);
      } catch (e) {
        this.solrDown = true;
        logError("esma-regulated: solr select failed, falling back to search", e);
      }
    }
    return this.search(body);
  }

  /** First regulated segment (in try order) with the ISIN; `checked` lists the segments covered. */
  async firds(
    isin: string,
    segments: readonly RegulatedSegment[],
  ): Promise<{ hit: ReturnType<typeof firstFirdsMatch>; checked: string[] }> {
    if (!this.solrDown) {
      try {
        const docs = await this.solr(
          firdsSolrUrl(
            isin,
            segments.map((s) => s.mic),
          ),
        );
        return { hit: firstFirdsMatch(docs, isin, segments), checked: segments.map((s) => s.mic) };
      } catch (e) {
        this.solrDown = true;
        logError("esma-regulated: solr select failed, falling back to search", e);
      }
    }
    const checked: string[] = [];
    for (const segment of segments) {
      checked.push(segment.mic);
      const docs = await this.search(firdsQuery(isin, segment.mic));
      const hit = firstFirdsMatch(docs, isin, [segment]);
      if (hit) return { hit, checked };
    }
    return { hit: undefined, checked };
  }
}

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), [deps.siteOrigin]);

  if (req.method === "OPTIONS") {
    if (!cors["access-control-allow-origin"])
      return new Response(null, { status: 403, headers: cors });
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, cors);

  const nowMs = deps.now();
  try {
    // A broken limiter must not take the site down: fail open, never log the IP.
    const rate = await checkRate(
      deps.store,
      req,
      deps.rateLimitSalt,
      "esma-regulated",
      nowMs,
    ).catch((e) => {
      logError("rate limiter unavailable", e);
      return { allowed: true, retryAfterSec: 1 };
    });
    if (!rate.allowed) {
      return json(
        429,
        { error: "rate limit exceeded" },
        { ...cors, "Retry-After": String(rate.retryAfterSec) },
      );
    }

    const auth = await authenticate(req, deps.verifier, cors);
    if (!auth.ok) return auth.response;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid JSON" }, cors);
    }
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const isin = typeof input.isin === "string" ? normalizeIsin(input.isin) : "";
    if (!isValidIsin(isin)) return json(400, { error: "invalid ISIN" }, cors);
    const exchange = typeof input.mic === "string" ? findEuExchange(input.mic) : undefined;
    if (!exchange) return json(400, { error: "unknown MIC" }, cors);

    const esma = new EsmaClient(deps, nowMs);
    const finish = (verdict: Verdict, extra: Partial<RegulatedResult> = {}): Response => {
      const result: RegulatedResult = {
        isin,
        mic: exchange.mic,
        exchangeName: exchange.name,
        verdict,
        matchedSegment: null,
        instrumentName: null,
        regulatedSegments: [],
        checkedSegments: [],
        ...extra,
        checkedAt: new Date(nowMs).toISOString(),
        source: esma.source,
      };
      return json(200, result, cors);
    };

    // Step 1: which segments of this exchange does ESMA list as a regulated market?
    const venueDocs = await esma.venues(exchange.leis, exchange.mic);
    if (!hasExchangeSegment(venueDocs, exchange)) return finish("not-in-esma");
    const regulated = pickRegulatedSegments(venueDocs, exchange);
    if (regulated.length === 0) return finish("no-regulated-segment");

    // Step 2: is the ISIN admitted on one of them?
    const { hit, checked } = await esma.firds(isin, regulated);
    if (hit) {
      const name = hit.doc.gnr_full_name;
      return finish("regulated", {
        matchedSegment: hit.segment,
        instrumentName: typeof name === "string" ? name : null,
        regulatedSegments: regulated,
        checkedSegments: checked,
      });
    }
    return finish("not-offered", { regulatedSegments: regulated, checkedSegments: checked });
  } catch (e) {
    if (e instanceof EsmaUnavailableError) {
      logError("esma-regulated: ESMA unavailable", e);
      return json(502, { error: "esma-unavailable", manualUrls: ESMA_MANUAL_URLS }, cors);
    }
    logError("esma-regulated failed", e);
    return json(502, { error: "upstream unavailable" }, cors);
  }
}
