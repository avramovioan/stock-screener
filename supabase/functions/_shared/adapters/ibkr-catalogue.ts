import type { Clock } from "./clock.ts";

/**
 * Weekly import of IBKR's public product catalogue for Xetra (IBIS) and Euronext Amsterdam (AEB) (spec 5.7, flex 4).
 * The endpoints are undocumented and unauthenticated; permission for programmatic use is UNVERIFIED (Q-10), so this adapter is deliberately
 * gentle: 100-row pages, 300 ms between requests, at most 35 pages and 50 requests per import, three retries with exponential backoff
 * and then the import is abandoned for the day. It never loops and never runs on a user request path.
 */

export const CATALOGUE_ENDPOINT =
  "https://www.interactivebrokers.com/webrest/search/products-by-exchangeId";
export const CATALOGUE_REFERER =
  "https://www.interactivebrokers.com/en/trading/products-exchanges.php";
export const CATALOGUE_USER_AGENT =
  "personal-stock-screener/1.0 (single-owner weekly catalogue import of IBIS and AEB; low volume: about 35 requests per week)";
export const PAGE_SIZE = 100; // pageSize 2000 returned HTTP 500 in the research probe
export const SPACING_MS = 300;
export const MAX_PAGES = 35; // IBIS 23 pages + AEB 11 pages today (flex 4)
export const MAX_REQUESTS = 50; // pages plus retries, across the whole import
export const MAX_RETRIES = 3;
export const BACKOFF_BASE_MS = 1_000;
export const RETRY_AFTER_CAP_MS = 60_000;

export type CatalogueFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Row shape of public.ibkr_catalogue (spec 6.3; `type` and `imported_at` are named `product_type` and `fetched_at`, A-19 variant). */
export interface CatalogueRow {
  exchange_id: string;
  conid: number;
  symbol: string;
  local_symbol: string;
  isin: string | null;
  currency: string;
  description: string | null;
  product_type: string;
  fetched_at: string;
}

export type AbortReason =
  | "http_error"
  | "network_error"
  | "bad_shape"
  | "page_budget"
  | "request_budget"
  | "aborted";
export interface ImportAbort {
  reason: AbortReason;
  status: number | null;
  page: number;
}

export interface SkipCounts {
  wrong_type: number;
  wrong_currency: number;
  invalid: number;
}

export interface FetchExchangeResult {
  exchangeId: string;
  rows: CatalogueRow[]; // STK and EUR only
  scanned: number; // every product row seen, before filtering
  pages: number;
  productCount: number | null;
  complete: boolean;
  aborted: ImportAbort | null;
  skipped: SkipCounts;
}

/** Shared by every exchange of one import so the page, request and spacing limits hold for the whole import. */
export interface ImportBudget {
  maxPages: number;
  maxRequests: number;
  pages: number;
  requests: number;
  lastRequestAt: number | null;
}

export function createImportBudget(
  opts: { maxPages?: number; maxRequests?: number } = {},
): ImportBudget {
  return {
    maxPages: opts.maxPages ?? MAX_PAGES,
    maxRequests: opts.maxRequests ?? MAX_REQUESTS,
    pages: 0,
    requests: 0,
    lastRequestAt: null,
  };
}

export interface FetchDeps {
  fetchImpl: CatalogueFetch;
  clock: Pick<Clock, "now">;
  pause: (ms: number) => Promise<void>;
  budget?: ImportBudget;
  signal?: AbortSignal;
  /** Per-request timeout in ms (default 15 000). */
  requestTimeoutMs?: number;
  /** ISO timestamp written into every row (injected so tests are deterministic). */
  fetchedAt?: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** The caller's signal (if any) combined with a per-request timeout; manual fallback when AbortSignal.any is unavailable. */
function requestSignal(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (outer === undefined) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([outer, timeout]);
  const ctl = new AbortController();
  const abort = (s: AbortSignal) => () => ctl.abort(s.reason);
  if (outer.aborted) ctl.abort(outer.reason);
  else outer.addEventListener("abort", abort(outer), { once: true });
  timeout.addEventListener("abort", abort(timeout), { once: true });
  return ctl.signal;
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

type Skip = keyof SkipCounts;

/** Pure: one raw product to a catalogue row, or the reason it is skipped. Only EUR stocks are kept (ETFs, indices, other currencies are not equivalents). */
export function mapProduct(
  raw: unknown,
  exchangeId: string,
  fetchedAt: string,
): { row: CatalogueRow } | { skip: Skip } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { skip: "invalid" };
  const p = raw as Record<string, unknown>;
  if (p["type"] !== "STK")
    return { skip: typeof p["type"] === "string" ? "wrong_type" : "invalid" };
  if (p["currency"] !== "EUR")
    return { skip: typeof p["currency"] === "string" ? "wrong_currency" : "invalid" };
  const conid =
    typeof p["conid"] === "string" && /^\d+$/.test(p["conid"]) ? Number(p["conid"]) : p["conid"];
  const symbol = typeof p["symbol"] === "string" ? p["symbol"].trim() : "";
  const localSymbol = typeof p["localSymbol"] === "string" ? p["localSymbol"].trim() : "";
  if (
    typeof conid !== "number" ||
    !Number.isSafeInteger(conid) ||
    conid <= 0 ||
    symbol === "" ||
    localSymbol === ""
  )
    return { skip: "invalid" };
  const isin =
    typeof p["isin"] === "string" && ISIN.test(p["isin"].trim().toUpperCase())
      ? p["isin"].trim().toUpperCase()
      : null;
  const description =
    typeof p["description"] === "string" && p["description"].trim() !== ""
      ? p["description"].trim()
      : null;
  return {
    row: {
      exchange_id: exchangeId,
      conid,
      symbol,
      local_symbol: localSymbol,
      isin,
      currency: "EUR",
      description,
      product_type: "STK",
      fetched_at: fetchedAt,
    },
  };
}

/** Seconds only (the HTTP-date form is ignored); capped so a hostile header cannot park the job. */
export function retryAfterMs(res: Pick<Response, "headers">): number | null {
  const v = res.headers.get("retry-after");
  if (v === null || !/^\d+$/.test(v.trim())) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Number(v.trim()) * 1_000);
}

const retryable = (status: number): boolean => status === 429 || status >= 500;
const backoffMs = (failures: number): number => BACKOFF_BASE_MS * 2 ** failures; // 1 s, 2 s, 4 s

type PageOutcome =
  | { kind: "page"; products: unknown[]; productCount: number | null }
  | { kind: "abort"; abort: Omit<ImportAbort, "page"> };

async function requestPage(
  exchangeId: string,
  pageNumber: number,
  deps: FetchDeps,
  budget: ImportBudget,
): Promise<PageOutcome> {
  const body = JSON.stringify({
    domain: "com",
    exchangeId,
    pageNumber,
    pageSize: PAGE_SIZE,
    sortDirection: "asc",
    sortField: "symbol",
  });
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Referer: CATALOGUE_REFERER,
    "User-Agent": CATALOGUE_USER_AGENT,
  };
  const isAborted = (): boolean => deps.signal?.aborted === true;
  for (let failures = 0; failures <= MAX_RETRIES; failures++) {
    if (isAborted()) return { kind: "abort", abort: { reason: "aborted", status: null } };
    if (budget.requests >= budget.maxRequests)
      return { kind: "abort", abort: { reason: "request_budget", status: null } };
    const wait =
      budget.lastRequestAt === null
        ? 0
        : Math.max(0, SPACING_MS - (deps.clock.now() - budget.lastRequestAt));
    if (wait > 0) await deps.pause(wait);
    if (isAborted()) return { kind: "abort", abort: { reason: "aborted", status: null } };
    budget.lastRequestAt = deps.clock.now();
    budget.requests += 1;

    let res: Response;
    try {
      res = await deps.fetchImpl(CATALOGUE_ENDPOINT, {
        method: "POST",
        headers,
        body,
        signal: requestSignal(deps.signal, deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (_e) {
      if (isAborted()) return { kind: "abort", abort: { reason: "aborted", status: null } };
      if (failures === MAX_RETRIES)
        return { kind: "abort", abort: { reason: "network_error", status: null } };
      await deps.pause(backoffMs(failures));
      continue;
    }

    if (res.ok) {
      let json: unknown;
      try {
        json = await res.json();
      } catch (_e) {
        return { kind: "abort", abort: { reason: "bad_shape", status: res.status } };
      }
      const products = (json as { products?: unknown } | null)?.products;
      if (!Array.isArray(products))
        return { kind: "abort", abort: { reason: "bad_shape", status: res.status } };
      const count = (json as { productCount?: unknown }).productCount;
      return {
        kind: "page",
        products,
        productCount: typeof count === "number" && Number.isFinite(count) ? count : null,
      };
    }

    const status = res.status;
    const hint = retryAfterMs(res);
    await res.body?.cancel();
    if (!retryable(status) || failures === MAX_RETRIES)
      return { kind: "abort", abort: { reason: "http_error", status } };
    await deps.pause(Math.max(backoffMs(failures), hint ?? 0));
  }
  return { kind: "abort", abort: { reason: "http_error", status: null } }; // unreachable: the loop returns on its last iteration
}

/**
 * Pages through one exchange. Stops on the first short or empty page, when `productCount` rows were seen, on the first abort condition
 * (HTTP error after retries, bad response shape, page or request budget, abort signal). Never throws for network or HTTP problems: the
 * caller reads `complete` and `aborted`. An aborted result still carries the rows read so far, but the caller must not treat it as a full import.
 */
export async function fetchExchangeProducts(
  exchangeId: string,
  deps: FetchDeps,
): Promise<FetchExchangeResult> {
  const budget = deps.budget ?? createImportBudget();
  const fetchedAt = deps.fetchedAt ?? new Date(deps.clock.now()).toISOString();
  const result: FetchExchangeResult = {
    exchangeId,
    rows: [],
    scanned: 0,
    pages: 0,
    productCount: null,
    complete: false,
    aborted: null,
    skipped: { wrong_type: 0, wrong_currency: 0, invalid: 0 },
  };
  for (let page = 1; ; page++) {
    if (budget.pages >= budget.maxPages) {
      result.aborted = { reason: "page_budget", status: null, page };
      return result;
    }
    const outcome = await requestPage(exchangeId, page, deps, budget);
    if (outcome.kind === "abort") {
      result.aborted = { ...outcome.abort, page };
      return result;
    }
    budget.pages += 1;
    result.pages += 1;
    if (outcome.productCount !== null) result.productCount = outcome.productCount;
    for (const raw of outcome.products) {
      result.scanned += 1;
      const mapped = mapProduct(raw, exchangeId, fetchedAt);
      if ("row" in mapped) result.rows.push(mapped.row);
      else result.skipped[mapped.skip] += 1;
    }
    const seenAll = result.productCount !== null && result.scanned >= result.productCount;
    if (seenAll) {
      result.complete = true;
      return result;
    }
    if (outcome.products.length < PAGE_SIZE) {
      // a short page ends the import only when no productCount contradicts it (the endpoint may clamp the page size)
      if (result.productCount === null) result.complete = true;
      if (result.productCount === null || outcome.products.length === 0) return result;
    }
  }
}

/** Offline `fetch` for fixture mode and tests: answers the catalogue endpoint from per-exchange page arrays (an unknown page is an empty page). */
export function createFixtureCatalogueFetch(pages: Record<string, unknown[][]>): CatalogueFetch {
  return (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      exchangeId?: string;
      pageNumber?: number;
    };
    const list = pages[String(body.exchangeId)] ?? [];
    const products = list[(body.pageNumber ?? 1) - 1] ?? [];
    const productCount = list.reduce((n, p) => n + p.length, 0);
    return Promise.resolve(
      new Response(JSON.stringify({ products, productTypeCount: [], productCount }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}
