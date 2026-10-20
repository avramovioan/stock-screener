import type { Clock } from "./clock.ts";
import type { KvStore } from "./store.ts";
import type { FetchLike } from "./throttle.ts";

/**
 * Cookie + crumb for the raw screener endpoint (the library cannot run custom screener queries and keeps its own crumb
 * private). Flow verified live in the spike (3.7): GET fc.yahoo.com sets cookie A3 (HTTP 404), then GET getcrumb with it.
 */
export interface YahooSession {
  cookie: string;
  crumb: string;
  acquiredAtMs: number;
}

export const SESSION_KEY = "yahoo:session";
export const SESSION_TTL_MS = 6 * 60 * 60_000;
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class YahooSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooSessionError";
  }
}

function cookieHeaderFrom(res: Response): string {
  const raw =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  return raw
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}

export async function acquireSession(fetchImpl: FetchLike, clock: Clock): Promise<YahooSession> {
  const first = await fetchImpl("https://fc.yahoo.com", {
    headers: { "User-Agent": BROWSER_UA },
    redirect: "manual",
  });
  await first.body?.cancel();
  const cookie = cookieHeaderFrom(first);
  if (cookie === "") throw new YahooSessionError("yahoo_session_no_cookie");

  const second = await fetchImpl("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": BROWSER_UA, Cookie: cookie },
  });
  if (!second.ok) {
    await second.body?.cancel();
    throw new YahooSessionError(`yahoo_session_crumb_http_${second.status}`);
  }
  const crumb = (await second.text()).trim();
  if (crumb === "" || crumb.length > 64 || /[<>{}\s]/.test(crumb))
    throw new YahooSessionError("yahoo_session_bad_crumb");
  return { cookie, crumb, acquiredAtMs: clock.now() };
}

/** Restores the cached session (6 h) or acquires a new one. `force` discards the cache first (HTTP 401 Invalid Crumb). */
export async function getSession(
  store: KvStore,
  fetchImpl: FetchLike,
  clock: Clock,
  force = false,
): Promise<YahooSession> {
  if (!force) {
    const cached = await store.get<YahooSession>(SESSION_KEY);
    if (cached !== null && typeof cached.crumb === "string" && typeof cached.cookie === "string")
      return cached;
  } else {
    await store.delete(SESSION_KEY);
  }
  const session = await acquireSession(fetchImpl, clock);
  await store.set(SESSION_KEY, session, SESSION_TTL_MS);
  return session;
}
