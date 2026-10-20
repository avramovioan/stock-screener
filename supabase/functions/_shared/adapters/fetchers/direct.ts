import type { FetchLike } from "../llm/types.ts";
import { htmlToText } from "./extract.ts";
import { type Limiter, secLimiter } from "./limiter.ts";

const ALLOWED_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/pdf",
]);
const DEFAULT_UA = "personal-stock-screener/1.0 (public research fetcher)";
const ACCEPT = "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.1";
const MAX_REDIRECTS = 4;

export interface DocFetchOk {
  ok: true;
  status: number;
  contentType: string;
  /** Plain text; null for a PDF (route it to Jina Reader). */
  text: string | null;
  truncated: boolean;
  finalUrl: string;
  bytes: number;
  /** "skipped" when no DNS resolution was available or permitted (the host name was not checked against DNS). */
  dnsCheck: "ok" | "skipped";
}

export interface DocFetchFail {
  ok: false;
  kind: "blocked" | "http" | "content_type" | "timeout" | "network";
  status?: number | undefined;
  message: string;
}

export type DocFetchResult = DocFetchOk | DocFetchFail;

export interface DirectOptions {
  signal?: AbortSignal | undefined;
  fetchImpl?: FetchLike | undefined;
  secUserAgent?: string | undefined;
  userAgent?: string | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  limiter?: Limiter | undefined;
  /** Accepted content types (default: HTML, XHTML, plain text, PDF). */
  allowedTypes?: ReadonlySet<string> | undefined;
  accept?: string | undefined;
  /** Return the body undecoded (no HTML stripping), for XML feeds. */
  rawText?: boolean | undefined;
  /**
   * DNS resolver used to reject host names that resolve to non-public addresses. When omitted, `Deno.resolveDns`
   * is used only if no `fetchImpl` is injected (tests never touch the network); `false` disables the check.
   */
  resolveDns?: DnsResolver | false | undefined;
}

/** Resolves a host to addresses of the given record type; may throw when unavailable or not permitted. */
export type DnsResolver = (host: string, type: "A" | "AAAA") => Promise<string[]>;

export function isSecHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "sec.gov" || h.endsWith(".sec.gov");
}

/** Non-public IPv4: this-network, private, CGNAT, loopback, link-local, IETF, benchmarking, multicast, reserved. */
function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function parseV4(text: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const n: [number, number, number, number] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
  ];
  return n.every((x) => x <= 255) ? n : null;
}

/** Parses an IPv6 literal (no brackets) into eight 16-bit groups, or null when malformed. */
function parseV6(text: string): number[] | null {
  let t = text.toLowerCase();
  const zone = t.indexOf("%");
  if (zone >= 0) t = t.slice(0, zone);
  const lastColon = t.lastIndexOf(":");
  const tail = t.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    t = `${t.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? "");
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] ?? "");
  if (!rest || head.length + rest.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/** True when an IPv4 or IPv6 literal (no brackets) is not a public unicast address; unparseable input counts as non-public. */
export function isNonPublicIp(text: string): boolean {
  const v4 = parseV4(text);
  if (v4) return privateV4(v4[0], v4[1], v4[2]);
  const g = parseV6(text);
  if (!g) return true;
  const g0 = g[0] ?? 0;
  const g5 = g[5] ?? 0;
  const g6 = g[6] ?? 0;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  const mapped = g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff; // ::ffff:a.b.c.d
  const compat = g.slice(0, 6).every((x) => x === 0); // ::a.b.c.d (deprecated)
  if (mapped || compat) return privateV4(g6 >> 8, g6 & 255, (g[7] ?? 0) >> 8);
  return false;
}

/**
 * SSRF guard for URLs that come from search results: returns the reason a URL must not be requested, or null.
 * Static checks only; `checkHostDns` adds the resolution check.
 */
export function publicUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `unsupported protocol ${url.protocol}`;
  }
  if (url.username !== "" || url.password !== "") return "credentials in URL";
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[")) {
    return isNonPublicIp(host.slice(1, -1)) ? "private or reserved IPv6 address" : null;
  }
  host = host.replace(/\.+$/, "");
  if (host === "") return "empty host";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return "local host";
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isNonPublicIp(host) ? "private address" : null;
  }
  if (!host.includes(".")) return "single-label host";
  return null;
}

function defaultResolver(): DnsResolver | null {
  const deno = (globalThis as { Deno?: { resolveDns?: DnsResolver } }).Deno;
  const fn = deno?.resolveDns;
  return typeof fn === "function" ? (host, type) => fn.call(deno, host, type) : null;
}

/**
 * Resolves a non-IP host (A and AAAA) and rejects it when any answer is non-public. When resolution is
 * unavailable or not permitted the check is skipped and reported as `dnsCheck: "skipped"`.
 * Accepted limitation: DNS rebinding, a host that answers differently between this check and the connect
 * made by `fetch`, is not prevented here.
 */
export async function checkHostDns(
  rawUrl: string,
  resolver: DnsResolver | null,
): Promise<{ problem: string | null; dnsCheck: "ok" | "skipped" }> {
  const host = new URL(rawUrl).hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { problem: null, dnsCheck: "ok" };
  }
  if (resolver === null) return { problem: null, dnsCheck: "skipped" };
  let answered = false;
  for (const type of ["A", "AAAA"] as const) {
    let addresses: string[];
    try {
      addresses = await resolver(host, type);
    } catch (e) {
      const detail = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      if (/permission|not.?capable|denied|not.?supported/i.test(detail)) {
        return { problem: null, dnsCheck: "skipped" };
      }
      continue; // NXDOMAIN or no records of this type
    }
    answered = true;
    for (const address of addresses) {
      if (isNonPublicIp(address)) {
        return { problem: `host resolves to non-public address ${address}`, dnsCheck: "ok" };
      }
    }
  }
  return { problem: null, dnsCheck: answered ? "ok" : "skipped" };
}

export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function failure(e: unknown, signal: AbortSignal): DocFetchFail {
  const timedOut =
    signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError";
  return timedOut
    ? { ok: false, kind: "timeout", message: "request timed out" }
    : {
        ok: false,
        kind: "network",
        message: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      };
}

/** GET with a 15 s timeout, a 2 MB read cap, a content-type allow-list and manual (re-checked) redirects. */
export async function fetchDocument(
  url: string,
  opts: DirectOptions = {},
): Promise<DocFetchResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const allowed = opts.allowedTypes ?? ALLOWED_TYPES;
  const resolver: DnsResolver | null =
    opts.resolveDns === false
      ? null
      : (opts.resolveDns ?? (opts.fetchImpl === undefined ? defaultResolver() : null));
  let dnsCheck: "ok" | "skipped" = "ok";
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = publicUrlProblem(current);
    if (problem) return { ok: false, kind: "blocked", message: problem };
    const dns = await checkHostDns(current, resolver);
    if (dns.problem) return { ok: false, kind: "blocked", message: dns.problem };
    if (dns.dnsCheck === "skipped") dnsCheck = "skipped";
    const host = new URL(current).hostname;
    const headers: Record<string, string> = {
      accept: opts.accept ?? ACCEPT,
      "user-agent": opts.userAgent ?? DEFAULT_UA,
    };
    if (isSecHost(host)) {
      const ua = opts.secUserAgent?.trim() ?? "";
      if (ua === "")
        return { ok: false, kind: "blocked", message: "SEC_USER_AGENT is not configured" };
      headers["user-agent"] = ua;
      await (opts.limiter ?? secLimiter).take();
    }
    let res: Response;
    try {
      res = await doFetch(current, { method: "GET", headers, redirect: "manual", signal });
    } catch (e) {
      return failure(e, signal);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) {
        return {
          ok: false,
          kind: "http",
          status: res.status,
          message: "redirect without location",
        };
      }
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, kind: "http", status: res.status, message: `HTTP ${res.status}` };
    }
    const contentType =
      (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!allowed.has(contentType)) {
      await res.body?.cancel();
      return {
        ok: false,
        kind: "content_type",
        status: res.status,
        message: `content type ${contentType || "(none)"} not allowed`,
      };
    }
    if (contentType === "application/pdf") {
      await res.body?.cancel();
      return {
        ok: true,
        status: res.status,
        contentType,
        text: null,
        truncated: false,
        finalUrl: current,
        bytes: 0,
        dnsCheck,
      };
    }
    try {
      const { bytes, truncated } = await readCapped(res, maxBytes);
      const raw = new TextDecoder("utf-8").decode(bytes);
      const text = opts.rawText || contentType === "text/plain" ? raw.trim() : htmlToText(raw);
      return {
        ok: true,
        status: res.status,
        contentType,
        text,
        truncated,
        finalUrl: current,
        bytes: bytes.length,
        dnsCheck,
      };
    } catch (e) {
      return failure(e, signal);
    }
  }
  return { ok: false, kind: "http", message: "too many redirects" };
}
