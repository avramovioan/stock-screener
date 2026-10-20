import type { RawBar } from "../core/bars.ts";
import type { Clock } from "./clock.ts";
import type {
  ChartRequest,
  ChartResult,
  CompanyProfile,
  MarketDataProvider,
  NewsItem,
  QuoteRecord,
  ScreenerPage,
  SearchHit,
  SplitEvent,
} from "./providers.ts";
import { BROWSER_UA, getSession } from "./session.ts";
import type { KvStore } from "./store.ts";
import {
  createKvBreakerStore,
  createThrottle,
  type FetchLike,
  type RateConfig,
  type ThrottleStats,
} from "./throttle.ts";

export const QUOTE_CHUNK = 500; // 2,500 symbols worked and 4,000 failed with HTTP 414 in the spike; 500 is the contract (5.2)
export const SCREENER_MAX_SIZE = 250; // size 500 returns HTTP 400 "size is too large" (spike 3.7)

export const QUOTE_FIELDS: readonly string[] = [
  "symbol",
  "quoteType",
  "currency",
  "financialCurrency",
  "exchange",
  "fullExchangeName",
  "longName",
  "shortName",
  "marketCap",
  "sharesOutstanding",
  "regularMarketPrice",
  "regularMarketTime",
  "regularMarketPreviousClose",
  "regularMarketChangePercent",
  "marketState",
  "firstTradeDateMilliseconds",
  "exchangeTimezoneName",
  "priceHint",
  "averageDailyVolume3Month",
];

export class YahooSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooSchemaError";
  }
}
export class YahooHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "YahooHttpError";
  }
}

// ---------------------------------------------------------------- pure mapping (tested against recorded samples)

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Instants arrive as Date, ISO string, epoch seconds (raw screener `regularMarketTime`) or epoch milliseconds
 * (raw `firstTradeDateMilliseconds`). `unit` says how to read a bare number.
 */
export function toMs(v: unknown, unit: "s" | "ms" = "ms"): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? (unit === "s" ? v * 1000 : v) : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Maps a quote()/screener row. Returns null (schema drift) when an identity field is missing. */
export function mapQuote(raw: unknown): QuoteRecord | null {
  if (!isRec(raw)) return null;
  const symbol = str(raw["symbol"]);
  const currency = str(raw["currency"]);
  const exchange = str(raw["exchange"]);
  const quoteType = str(raw["quoteType"]);
  if (symbol === null || currency === null || exchange === null || quoteType === null) return null;
  return {
    symbol,
    quoteType,
    currency,
    financialCurrency: str(raw["financialCurrency"]),
    exchange,
    fullExchangeName: str(raw["fullExchangeName"]),
    longName: str(raw["longName"]),
    shortName: str(raw["shortName"]),
    marketCap: num(raw["marketCap"]),
    sharesOutstanding: num(raw["sharesOutstanding"]),
    regularMarketPrice: num(raw["regularMarketPrice"]),
    regularMarketTime: toMs(raw["regularMarketTime"], "s"),
    regularMarketPreviousClose: num(raw["regularMarketPreviousClose"]),
    regularMarketChangePercent: num(raw["regularMarketChangePercent"]),
    marketState: str(raw["marketState"]),
    firstTradeDateMs: toMs(raw["firstTradeDateMilliseconds"], "ms"),
    exchangeTimezoneName: str(raw["exchangeTimezoneName"]),
    priceHint: num(raw["priceHint"]),
    averageDailyVolume3Month: num(raw["averageDailyVolume3Month"]),
  };
}

/** Maps a chart() result (library shape: meta, quotes[], events?). Null OHLCV rows are kept: cleanBars drops them. */
export function mapChart(raw: unknown): ChartResult {
  if (!isRec(raw) || !isRec(raw["meta"]) || !Array.isArray(raw["quotes"]))
    throw new YahooSchemaError("chart_shape");
  const meta = raw["meta"];
  const tz = str(meta["exchangeTimezoneName"]);
  if (tz === null) throw new YahooSchemaError("chart_meta_timezone_missing");
  const tradingPeriod = isRec(meta["currentTradingPeriod"]) ? meta["currentTradingPeriod"] : null;
  const regular =
    tradingPeriod !== null && isRec(tradingPeriod["regular"]) ? tradingPeriod["regular"] : null;
  const start = regular === null ? null : toMs(regular["start"], "s");
  const end = regular === null ? null : toMs(regular["end"], "s");

  const bars: RawBar[] = [];
  for (const q of raw["quotes"]) {
    if (!isRec(q)) continue;
    const time = toMs(q["date"], "s");
    if (time === null) continue;
    bars.push({
      time,
      open: num(q["open"]),
      high: num(q["high"]),
      low: num(q["low"]),
      close: num(q["close"]),
      volume: num(q["volume"]),
    });
  }

  const splits: SplitEvent[] = [];
  const events = isRec(raw["events"]) ? raw["events"] : null;
  if (events !== null && Array.isArray(events["splits"])) {
    for (const s of events["splits"]) {
      if (!isRec(s)) continue;
      const dateMs = toMs(s["date"], "s");
      const numerator = num(s["numerator"]);
      const denominator = num(s["denominator"]);
      if (dateMs !== null && numerator !== null && denominator !== null)
        splits.push({ dateMs, numerator, denominator });
    }
  }

  return {
    meta: {
      currency: str(meta["currency"]) ?? "",
      exchange: str(meta["exchangeName"]) ?? "",
      exchangeTimezoneName: tz,
      firstTradeDateMs: toMs(meta["firstTradeDate"], "s"),
      regularMarketTime: toMs(meta["regularMarketTime"], "s"),
      currentTradingPeriod: start !== null && end !== null ? { start, end } : null,
      instrumentType: str(meta["instrumentType"]),
      longName: str(meta["longName"]),
    },
    bars,
    splits,
  };
}

export function mapNews(raw: unknown): NewsItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NewsItem[] = [];
  for (const n of raw) {
    if (!isRec(n)) continue;
    const id = str(n["uuid"]);
    const title = str(n["title"]);
    const url = str(n["link"]);
    const publishedMs = toMs(n["providerPublishTime"], "s");
    if (id === null || title === null || url === null || publishedMs === null) continue;
    const related = Array.isArray(n["relatedTickers"])
      ? n["relatedTickers"].filter((t): t is string => typeof t === "string")
      : [];
    out.push({
      id,
      title,
      publisher: str(n["publisher"]),
      url,
      publishedMs,
      relatedTickers: related,
    });
  }
  return out;
}

export function mapSearch(raw: unknown): { hits: SearchHit[]; news: NewsItem[] } {
  if (!isRec(raw)) throw new YahooSchemaError("search_shape");
  const hits: SearchHit[] = [];
  if (Array.isArray(raw["quotes"])) {
    for (const q of raw["quotes"]) {
      if (!isRec(q) || q["isYahooFinance"] === false) continue;
      const symbol = str(q["symbol"]);
      const exchange = str(q["exchange"]);
      const quoteType = str(q["quoteType"]);
      if (symbol === null || exchange === null || quoteType === null) continue;
      hits.push({
        symbol,
        exchange,
        quoteType,
        longName: str(q["longname"]),
        shortName: str(q["shortname"]),
        sector: str(q["sector"]),
        industry: str(q["industry"]),
      });
    }
  }
  return { hits, news: mapNews(raw["news"]) };
}

export function mapProfile(symbol: string, raw: unknown): CompanyProfile {
  if (!isRec(raw)) throw new YahooSchemaError("profile_shape");
  const ap = isRec(raw["assetProfile"])
    ? raw["assetProfile"]
    : isRec(raw["summaryProfile"])
      ? raw["summaryProfile"]
      : null;
  if (ap === null) throw new YahooSchemaError("profile_missing_assetProfile");
  return {
    symbol,
    country: str(ap["country"]),
    sector: str(ap["sector"]),
    industry: str(ap["industry"]),
    summary: str(ap["longBusinessSummary"]),
    employees: num(ap["fullTimeEmployees"]),
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------- provider

/** The four library calls the adapter uses. The real YahooFinance instance satisfies it; tests inject recorded results. */
export interface YahooClientLike {
  quote(
    symbols: string[],
    query: { fields?: string[] },
    opts: { validateResult: false },
  ): Promise<unknown>;
  chart(
    symbol: string,
    query: Record<string, unknown>,
    opts: { validateResult: false },
  ): Promise<unknown>;
  search(
    q: string,
    query: Record<string, unknown>,
    opts: { validateResult: false },
  ): Promise<unknown>;
  quoteSummary(
    symbol: string,
    query: { modules: string[] },
    opts: { validateResult: false },
  ): Promise<unknown>;
}

export type Recorder = (entry: {
  method: string;
  url: string;
  status: number;
  body: string;
}) => Promise<void>;

export interface YahooProviderOptions {
  fetchImpl: FetchLike;
  store: KvStore;
  clock: Clock;
  rate?: RateConfig;
  rng?: () => number;
  budgetMs?: number;
  client?: YahooClientLike;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  /** Kill switch (spec 15.5), passed to the throttle. */
  isEnabled?: () => Promise<boolean>;
  /** Dev switch: when set, every response is also passed to the recorder (see fixtures.ts). Never enabled in production. */
  recorder?: Recorder;
}

export type YahooProvider = MarketDataProvider & {
  stats(): ThrottleStats & { schemaDrift: number };
};

export function stripCrumb(url: string): string {
  return url.replace(/([?&])crumb=[^&]*/g, "$1crumb=REDACTED");
}

/** Session bootstrap responses carry the cookie and the crumb itself: they are never recorded. */
export function isSessionUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.host === "fc.yahoo.com" || u.pathname.includes("/v1/test/getcrumb");
  } catch {
    return true; // unparseable: do not record
  }
}

export function createYahooProvider(o: YahooProviderOptions): YahooProvider {
  const emit = o.onEvent ?? (() => undefined);
  let drift = 0;
  const noteDrift = (where: string) => {
    drift += 1;
    emit("yahoo_schema_drift", { where });
  };

  const recordingFetch: FetchLike =
    o.recorder === undefined
      ? o.fetchImpl
      : async (input, init) => {
          const res = await o.fetchImpl(input, init);
          const rawUrl = input instanceof Request ? input.url : String(input);
          if (isSessionUrl(rawUrl)) return res; // cookie and crumb responses are never recorded
          const body = await res.clone().text();
          // only method, redacted URL, status and body are recorded: no request or response headers (cookies)
          await o.recorder?.({
            method: init?.method ?? "GET",
            url: stripCrumb(rawUrl),
            status: res.status,
            body,
          });
          return res;
        };

  const throttle = createThrottle({
    fetchImpl: recordingFetch,
    clock: o.clock,
    breaker: createKvBreakerStore(o.store),
    ...(o.rate === undefined ? {} : { rate: o.rate }),
    ...(o.rng === undefined ? {} : { rng: o.rng }),
    ...(o.budgetMs === undefined ? {} : { budgetMs: o.budgetMs }),
    ...(o.isEnabled === undefined ? {} : { isEnabled: o.isEnabled }),
    onEvent: emit,
  });

  let clientPromise: Promise<YahooClientLike> | undefined;
  const getClient = (): Promise<YahooClientLike> => {
    if (o.client !== undefined) return Promise.resolve(o.client);
    clientPromise ??= import("npm:yahoo-finance2@4.0.3").then((mod) => {
      const YahooFinance = mod.default as unknown as new (opts: Record<string, unknown>) => unknown;
      return new YahooFinance({
        suppressNotices: ["yahooSurvey"],
        fetch: throttle.fetch, // crumb, cookie and data requests all pass through our pacing, retry and breaker
        validation: { logErrors: false },
      }) as YahooClientLike;
    });
    return clientPromise;
  };
  const NO_VALIDATION = { validateResult: false } as const;

  async function screenRaw(body: unknown, crumbRetry: boolean): Promise<Rec> {
    const session = await getSession(o.store, throttle.fetch, o.clock, !crumbRetry);
    const url = `https://query1.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(session.crumb)}&lang=en-US&region=US&formatted=false`;
    const res = await throttle.fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: session.cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && crumbRetry) {
      await res.body?.cancel();
      return screenRaw(body, false); // discard the session, reacquire once
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new YahooHttpError(res.status, `screener_http_${res.status}`);
    }
    const json: unknown = await res.json();
    const finance = isRec(json) && isRec(json["finance"]) ? json["finance"] : null;
    if (finance === null) throw new YahooSchemaError("screener_shape");
    if (finance["error"] !== null && finance["error"] !== undefined)
      throw new YahooHttpError(200, "screener_error");
    const result = Array.isArray(finance["result"]) ? finance["result"][0] : undefined;
    if (!isRec(result) || !Array.isArray(result["quotes"]))
      throw new YahooSchemaError("screener_result_shape");
    return result;
  }

  return {
    id: "yahoo",

    async search(q, opts) {
      const client = await getClient();
      const raw = await client.search(
        q,
        { quotesCount: opts?.quotesCount ?? 15, newsCount: opts?.newsCount ?? 0 },
        NO_VALIDATION,
      );
      return mapSearch(raw);
    },

    async quote(symbols, opts) {
      const unique = [...new Set(symbols)];
      if (unique.length === 0) return [];
      const client = await getClient();
      const fields = opts?.fields ?? [...QUOTE_FIELDS];
      const out: QuoteRecord[] = [];
      for (const part of chunk(unique, QUOTE_CHUNK)) {
        const raw = await client.quote(part, { fields }, NO_VALIDATION);
        if (!Array.isArray(raw)) {
          noteDrift("quote.response_not_array"); // a malformed batch is a failure, never "all symbols unknown"
          throw new YahooSchemaError("quote_shape");
        }
        const rows = raw;
        for (const row of rows) {
          const mapped = mapQuote(row);
          if (mapped === null) noteDrift("quote.identity_field_missing");
          else out.push(mapped);
        }
      }
      return out; // unknown symbols are simply absent
    },

    async chart(symbol, req: ChartRequest) {
      const client = await getClient();
      const query: Record<string, unknown> = {
        period1: req.period1,
        interval: req.interval,
        events: req.events,
      };
      if (req.period2 !== undefined) query["period2"] = req.period2;
      return mapChart(await client.chart(symbol, query, NO_VALIDATION));
    },

    async profile(symbol) {
      const client = await getClient();
      return mapProfile(
        symbol,
        await client.quoteSummary(
          symbol,
          { modules: ["assetProfile", "quoteType", "price"] },
          NO_VALIDATION,
        ),
      );
    },

    async news(symbol, count) {
      const client = await getClient();
      const raw = await client.search(
        symbol,
        { quotesCount: 0, newsCount: Math.min(50, count) },
        NO_VALIDATION,
      );
      return mapSearch(raw).news;
    },

    async screen(req): Promise<ScreenerPage> {
      if (req.size < 1 || req.size > SCREENER_MAX_SIZE)
        throw new RangeError(`screener size must be 1..${SCREENER_MAX_SIZE}`);
      const body = {
        size: req.size,
        offset: req.offset,
        sortField: "intradaymarketcap",
        sortType: "DESC",
        quoteType: "EQUITY",
        query: {
          operator: "and",
          operands: [
            { operator: "gt", operands: ["intradaymarketcap", req.minMarketCapLocal] },
            { operator: "eq", operands: ["exchange", req.exchange] },
          ],
        },
        userId: "",
        userIdType: "guid",
      };
      const result = await screenRaw(body, true);
      const rows: QuoteRecord[] = [];
      for (const q of result["quotes"] as unknown[]) {
        const mapped = mapQuote(q);
        if (mapped === null) noteDrift("screener.identity_field_missing");
        else rows.push(mapped);
      }
      return {
        total: num(result["total"]) ?? rows.length,
        offset: num(result["start"]) ?? req.offset,
        count: num(result["count"]) ?? rows.length,
        rows,
      };
    },

    stats() {
      return { ...throttle.stats(), schemaDrift: drift };
    },
  };
}

/**
 * Walks one exchange's screener pages (size 250). Stops at offset >= total, on an empty page, or after maxPages;
 * in the last case nextOffset says where a follow-up job continues.
 */
export async function collectScreenerPages(
  provider: Pick<MarketDataProvider, "screen">,
  req: {
    exchange: string;
    minMarketCapLocal: number;
    startOffset?: number;
    size?: number;
    maxPages: number;
  },
): Promise<{ rows: QuoteRecord[]; pages: number; total: number; nextOffset: number | null }> {
  const size = req.size ?? SCREENER_MAX_SIZE;
  let offset = req.startOffset ?? 0;
  const rows: QuoteRecord[] = [];
  let pages = 0;
  let total = 0;
  while (pages < req.maxPages) {
    const page = await provider.screen({
      exchange: req.exchange,
      minMarketCapLocal: req.minMarketCapLocal,
      offset,
      size,
    });
    pages += 1;
    total = page.total;
    rows.push(...page.rows);
    offset += size;
    if (page.count === 0 || offset >= page.total) return { rows, pages, total, nextOffset: null };
  }
  return { rows, pages, total, nextOffset: offset };
}
