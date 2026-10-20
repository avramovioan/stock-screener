// IBKR Flex Web Service client (spec 12.4, research flex 2.3). No network access except through the injected fetch.
// The token travels in the URL query (that is the Flex protocol): URLs are never logged and error messages never include them.
import { XMLParser } from "npm:fast-xml-parser@5.11.2";
import { requireEnv } from "./env.ts";
import { containsDtd } from "./flex-parse.ts";

/** Hard cap on a Flex response body, enforced while streaming. */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export class FlexTooLargeError extends Error {
  readonly code = "too_large";
  constructor() {
    super("Flex response exceeds the size limit");
    this.name = "FlexTooLargeError";
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new FlexTooLargeError();
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FlexTooLargeError();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const FLEX_BASE_URL =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

export type FlexPeriod = { days: number } | { from: string; to: string };

export type SendResult =
  | {
      ok: true;
      referenceCode: string /** returned by IBKR and deliberately never fetched */;
      url: string | null;
    }
  | { ok: false; code: number; message: string };

export type StatementResult =
  | { ok: true; xml: string }
  | { ok: false; code: number; message: string };

export interface FlexLimiter {
  acquire(token: string): Promise<void>;
}

export class FlexLimiterError extends Error {
  constructor(readonly waitMs: number) {
    super("local Flex rate limit");
    this.name = "FlexLimiterError";
  }
}

export interface FlexClientOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  limiter?: FlexLimiter;
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface FlexClient {
  sendRequest(token: string, queryId: string, period?: FlexPeriod): Promise<SendResult>;
  getStatement(token: string, referenceCode: string): Promise<StatementResult>;
}

interface Envelope {
  status: string;
  errorCode: number | null;
  errorMessage: string | null;
  referenceCode: string | null;
  url: string | null;
}

const envelopeParser = new XMLParser({
  ignoreAttributes: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  trimValues: true,
});

function field(node: Record<string, unknown>, name: string): string | null {
  const key = Object.keys(node).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : node[key];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : null;
}

function parseEnvelope(text: string): Envelope | null {
  if (containsDtd(text)) return null;
  let doc: unknown;
  try {
    doc = envelopeParser.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const rootKey = Object.keys(doc).find((k) => k.toLowerCase() === "flexstatementresponse");
  const root = rootKey === undefined ? undefined : (doc as Record<string, unknown>)[rootKey];
  if (typeof root !== "object" || root === null) return null;
  const node = root as Record<string, unknown>;
  const rawCode = field(node, "errorcode");
  const message = field(node, "errormessage");
  const recovered =
    rawCode ?? (message === null ? null : (/\b(10\d{2})\b/.exec(message)?.[1] ?? null));
  return {
    status: field(node, "status") ?? "",
    errorCode: recovered === null || Number.isNaN(Number(recovered)) ? null : Number(recovered),
    errorMessage: message,
    referenceCode: field(node, "referencecode"),
    url: field(node, "url"),
  };
}

function ymd(value: string): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  return m === null ? null : `${m[1]}${m[2]}${m[3]}`;
}

function periodParams(period: FlexPeriod | undefined): Record<string, string> | null {
  if (period === undefined) return {};
  if ("days" in period) {
    return Number.isInteger(period.days) && period.days >= 1 && period.days <= 365
      ? { p: String(period.days) }
      : null;
  }
  const fd = ymd(period.from);
  const td = ymd(period.to);
  return fd !== null && td !== null && fd <= td ? { fd, td } : null;
}

export function createFlexClient(o: FlexClientOptions): FlexClient {
  if (typeof o.userAgent !== "string" || o.userAgent.trim() === "")
    throw new Error("FLEX_USER_AGENT is required: Flex rejects requests without a User-Agent");
  const maxBytes = o.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const fetchImpl = o.fetchImpl ?? fetch;
  const base = o.baseUrl ?? FLEX_BASE_URL;
  const timeoutMs = o.timeoutMs ?? 30_000;

  async function get(
    token: string,
    path: "SendRequest" | "GetStatement",
    params: Record<string, string>,
  ): Promise<{ ok: true; text: string } | { ok: false; code: number; message: string }> {
    if (o.limiter !== undefined) {
      try {
        await o.limiter.acquire(token);
      } catch (e) {
        if (e instanceof FlexLimiterError)
          return {
            ok: false,
            code: 1018,
            message: "Local rate limit reached; trying again later.",
          };
        throw e;
      }
    }
    const url = new URL(`${base}/${path}`);
    url.searchParams.set("t", token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("v", "3");
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          "User-Agent": o.userAgent,
          Accept: "text/xml, application/xml, text/plain, */*",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, code: 0, message: "Could not reach the IBKR Flex service." };
    }
    if (res.status === 429)
      return { ok: false, code: 1018, message: "Too many requests (HTTP 429)." };
    if (res.status >= 500)
      return { ok: false, code: 0, message: `IBKR Flex service error (HTTP ${res.status}).` };
    try {
      return { ok: true, text: await readCapped(res, maxBytes) };
    } catch (e) {
      if (e instanceof FlexTooLargeError)
        return { ok: false, code: -1, message: "The IBKR statement is too large to process." };
      return { ok: true, text: "" };
    }
  }

  function failure(env: Envelope | null): { ok: false; code: number; message: string } {
    if (env === null)
      return { ok: false, code: 0, message: "Unrecognised response from the IBKR Flex service." };
    return {
      ok: false,
      code: env.errorCode ?? 0,
      message: env.errorMessage ?? "The IBKR Flex service reported an error.",
    };
  }

  return {
    async sendRequest(token, queryId, period) {
      const extra = periodParams(period);
      if (extra === null) return { ok: false, code: 1020, message: "Invalid period." };
      const res = await get(token, "SendRequest", { q: queryId, ...extra });
      if (!res.ok) return res;
      const env = parseEnvelope(res.text);
      if (
        env !== null &&
        env.status.toLowerCase() === "success" &&
        env.referenceCode !== null &&
        env.referenceCode !== ""
      ) {
        return { ok: true, referenceCode: env.referenceCode, url: env.url };
      }
      return failure(env);
    },

    async getStatement(token, referenceCode) {
      const res = await get(token, "GetStatement", { q: referenceCode });
      if (!res.ok) return res;
      if (/<FlexQueryResponse[\s>]/.test(res.text)) return { ok: true, xml: res.text };
      return failure(parseEnvelope(res.text));
    },
  };
}

/** `flexrl:` + the first 32 hex characters of SHA-256(token): the limiter key never contains the token. */
export async function tokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `flexrl:${hex.slice(0, 32)}`;
}

/** Waits for `app.flex_rl_take(key)` (0 = granted, otherwise milliseconds to wait) and fails when the wait is longer than `maxWaitMs`. */
export function createRpcLimiter(o: {
  take(key: string): Promise<number>;
  sleep(ms: number): Promise<void>;
  maxWaitMs?: number;
  maxLoops?: number;
}): FlexLimiter {
  const maxWait = o.maxWaitMs ?? 15_000;
  const loops = o.maxLoops ?? 5;
  return {
    async acquire(token) {
      const key = await tokenKey(token);
      let last = 0;
      for (let i = 0; i < loops; i++) {
        last = await o.take(key);
        if (last <= 0) return;
        if (last > maxWait) throw new FlexLimiterError(last);
        await o.sleep(last);
      }
      throw new FlexLimiterError(last);
    },
  };
}

/** Production wiring: `FLEX_USER_AGENT` is mandatory (requireEnv throws when it is missing or blank). */
export function flexClientFromEnv(o: Omit<FlexClientOptions, "userAgent"> = {}): FlexClient {
  return createFlexClient({ ...o, userAgent: requireEnv("FLEX_USER_AGENT") });
}
