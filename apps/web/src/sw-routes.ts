/**
 * Pure rules shared by the service worker (sw.ts) and its tests. Keeping them free of service
 * worker globals is what makes the cache and notification policy testable (spec 14.8).
 */

// Same-origin paths that must never be answered from a cache or by the SPA navigation fallback:
// the OAuth callback (/auth/*), Edge Function and PostgREST proxies.
export const BYPASS_PATH = /^\/(auth|rest|functions)(\/|$)/;
export const NAVIGATION_DENYLIST: RegExp[] = [BYPASS_PATH];

function isSupabaseHost(hostname: string): boolean {
  return hostname === "supabase.co" || hostname.endsWith(".supabase.co");
}

/** True for requests that must go to the network and never be stored. */
export function isNeverCached(url: URL, headers: Headers, selfOrigin: string): boolean {
  if (isSupabaseHost(url.hostname)) return true;
  if (url.origin === selfOrigin && BYPASS_PATH.test(url.pathname)) return true;
  return headers.has("authorization") || headers.has("apikey");
}

export function isNavigationFallbackAllowed(url: URL): boolean {
  return !NAVIGATION_DENYLIST.some((pattern) => pattern.test(url.pathname));
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

const DEFAULT_TITLE = "Stock Screener";
const DEFAULT_BODY = "There is something new.";

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : clip(trimmed, max);
}

/** Never throws and always returns something displayable: iOS punishes silent pushes. */
export function parsePushPayload(raw: string): PushPayload {
  const fallback: PushPayload = { title: DEFAULT_TITLE, body: DEFAULT_BODY, url: "/" };
  const text = raw.trim();
  if (text === "") return fallback;
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      const tag = cleanString(record.tag, 64);
      return {
        title: cleanString(record.title, 100) ?? fallback.title,
        body: cleanString(record.body, 300) ?? fallback.body,
        url: cleanString(record.url, 500) ?? fallback.url,
        ...(tag === null ? {} : { tag }),
      };
    }
  } catch {
    // not JSON: show the text itself
  }
  return { ...fallback, body: clip(text, 300) };
}

/** Same-origin path (+ query + hash) or "/" : a push payload must not open another site. */
export function resolveNotificationUrl(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || raw.trim() === "") return "/";
  try {
    const target = new URL(raw, origin);
    if (target.origin !== origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
