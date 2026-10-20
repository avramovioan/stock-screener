import type { FetchLike } from "../llm/types.ts";
import { type Limiter, secLimiter } from "./limiter.ts";

export interface Filing {
  form: string;
  accession: string;
  filingDate: string;
  primaryDocument: string;
  reportDate: string | null;
}

export type EdgarResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "not_configured" | "http" | "network";
      status?: number | undefined;
      message: string;
    };

export interface EdgarClient {
  resolveCik(ticker: string): Promise<EdgarResult<string | null>>;
  submissions(cik: string): Promise<EdgarResult<Filing[]>>;
  filingUrl(cik: string, accession: string, primaryDocument: string): string;
}

export interface EdgarOptions {
  userAgent?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  limiter?: Limiter | undefined;
  signal?: AbortSignal | undefined;
}

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const TICKER_TTL_MS = 6 * 60 * 60 * 1000;
let tickerCache: { at: number; map: Map<string, string> } | null = null;

export function resetTickerCache(): void {
  tickerCache = null;
}

export const padCik = (cik: string | number): string =>
  String(cik).replace(/\D/g, "").padStart(10, "0");

export function createEdgarClient(opts: EdgarOptions): EdgarClient {
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const limiter = opts.limiter ?? secLimiter;
  const userAgent = opts.userAgent?.trim() ?? "";

  async function getJson(url: string): Promise<EdgarResult<unknown>> {
    if (userAgent === "") {
      return { ok: false, kind: "not_configured", message: "SEC_USER_AGENT is not configured" };
    }
    await limiter.take();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { "user-agent": userAgent, accept: "application/json" },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      return {
        ok: false,
        kind: "network",
        message: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, kind: "http", status: res.status, message: `EDGAR HTTP ${res.status}` };
    }
    try {
      return { ok: true, value: await res.json() };
    } catch {
      return {
        ok: false,
        kind: "http",
        status: res.status,
        message: "EDGAR returned invalid JSON",
      };
    }
  }

  return {
    async resolveCik(ticker) {
      const wanted = ticker.trim().toUpperCase();
      if (tickerCache === null || Date.now() - tickerCache.at > TICKER_TTL_MS) {
        const res = await getJson(TICKERS_URL);
        if (!res.ok) return res;
        const map = new Map<string, string>();
        if (res.value !== null && typeof res.value === "object") {
          for (const row of Object.values(res.value as Record<string, unknown>)) {
            const r = row as { cik_str?: number | string; ticker?: string };
            if (r.ticker && r.cik_str !== undefined)
              map.set(r.ticker.toUpperCase(), padCik(r.cik_str));
          }
        }
        tickerCache = { at: Date.now(), map };
      }
      return { ok: true, value: tickerCache.map.get(wanted) ?? null };
    },

    async submissions(cik) {
      const res = await getJson(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
      if (!res.ok) return res;
      const recent = (res.value as { filings?: { recent?: Record<string, unknown[]> } })?.filings
        ?.recent;
      const forms = recent?.form ?? [];
      const filings: Filing[] = [];
      for (let i = 0; i < forms.length; i++) {
        const form = String(forms[i] ?? "");
        const accession = String(recent?.accessionNumber?.[i] ?? "");
        const filingDate = String(recent?.filingDate?.[i] ?? "");
        const primaryDocument = String(recent?.primaryDocument?.[i] ?? "");
        if (form === "" || accession === "" || primaryDocument === "") continue;
        const reportDate = String(recent?.reportDate?.[i] ?? "");
        filings.push({
          form,
          accession,
          filingDate,
          primaryDocument,
          reportDate: reportDate === "" ? null : reportDate,
        });
      }
      return { ok: true, value: filings };
    },

    filingUrl(cik, accession, primaryDocument) {
      return `https://www.sec.gov/Archives/edgar/data/${Number(padCik(cik))}/${accession.replaceAll("-", "")}/${primaryDocument}`;
    },
  };
}
