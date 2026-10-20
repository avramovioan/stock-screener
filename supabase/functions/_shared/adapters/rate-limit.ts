import type { SupabaseClient } from "@supabase/supabase-js";
import { corsHeaders, json } from "./http.ts";

/** Behind Cloudflare the real client is `cf-connecting-ip`; otherwise the RIGHT-most `x-forwarded-for` entry (added by the proxy, not the client). */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const parts = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.at(-1) ?? "unknown";
}

/** SHA-256 of salt + UTC day + IP, truncated: the raw IP is never stored or logged; the salt rotates daily. */
export async function hashIp(ip: string, salt: string, nowMs: number): Promise<string> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${day}:${ip}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type RateWindow = "minute" | "hour";

const WINDOW_MS: Record<RateWindow, number> = { minute: 60_000, hour: 3_600_000 };

/** Bucket index, key and the window's end for one IP; counters expire two windows after the bucket starts. */
async function bucket(
  fn: string,
  window: RateWindow,
  req: Request,
  salt: string,
  nowMs: number,
): Promise<{ key: string; index: number; endMs: number }> {
  const size = WINDOW_MS[window];
  const index = Math.floor(nowMs / size);
  const key = `rl:${fn}:${await hashIp(clientIp(req), salt, nowMs)}:${index}`;
  return { key, index, endMs: (index + 1) * size };
}

export interface RateLimitOptions {
  fn: string;
  /** Requests allowed per window (the name is historical: the default window is a minute). */
  perMinute: number;
  /** Window length; the default is one minute, so existing callers are unchanged. */
  window?: RateWindow;
  salt: string;
  /** Atomic counter: returns the new count for the key. */
  incr: (key: string, expiresAtIso: string) => Promise<number>;
  now?: () => number;
}

/**
 * Per-IP request limit in front of a handler (spec 15.2 T7). Counters live in `quote_cache` rows `rl:<fn>:<hash>:<bucket>`
 * through `public.quotes_rl_incr`. A counter failure lets the request through: availability first, the per-user cooldowns
 * inside the handlers still apply. Actions that spend quota use `createAcceptedIpCounter` instead (fail closed, accepted only).
 */
export function withIpRateLimit(
  handler: (req: Request) => Response | Promise<Response>,
  o: RateLimitOptions,
): (req: Request) => Promise<Response> {
  const window = o.window ?? "minute";
  return async (req) => {
    if (req.method === "OPTIONS") return handler(req);
    const nowMs = (o.now ?? Date.now)();
    let b: { key: string; index: number; endMs: number };
    let count: number;
    try {
      b = await bucket(o.fn, window, req, o.salt, nowMs);
      count = await o.incr(b.key, new Date((b.index + 2) * WINDOW_MS[window]).toISOString());
    } catch {
      return handler(req);
    }
    if (count <= o.perMinute) return handler(req);
    const retryAfter = Math.max(1, Math.ceil((b.endMs - nowMs) / 1000));
    return json(
      { error: "rate_limited", retryAfterSeconds: retryAfter },
      {
        status: 429,
        headers: { "retry-after": String(retryAfter), ...corsHeaders(req.headers.get("origin")) },
      },
    );
  };
}

export interface AcceptedCounterOptions {
  fn: string;
  window: RateWindow;
  /** Accepted requests allowed per IP and window. */
  limit: number;
  salt: string;
  /** Current count of the key without changing it (0 when absent). */
  read: (key: string) => Promise<number>;
  incr: (key: string, expiresAtIso: string) => Promise<number>;
  now?: () => number;
}

/**
 * Accepted-only per-IP counter: `check` reads the bucket and never counts; the handler calls `commit` once every other policy
 * check has passed, so rejected requests never use up the allowance. Both throw when the counter is unavailable: the caller
 * must refuse the request (fail closed), because the action spends quota.
 */
export function createAcceptedIpCounter(o: AcceptedCounterOptions) {
  const nowMs = () => (o.now ?? Date.now)();
  return {
    async check(req: Request): Promise<{ allowed: boolean; resetAtIso: string }> {
      const t = nowMs();
      const b = await bucket(o.fn, o.window, req, o.salt, t);
      const used = await o.read(b.key);
      return { allowed: used < o.limit, resetAtIso: new Date(b.endMs).toISOString() };
    },
    async commit(req: Request): Promise<void> {
      const t = nowMs();
      const b = await bucket(o.fn, o.window, req, o.salt, t);
      await o.incr(b.key, new Date((b.index + 2) * WINDOW_MS[o.window]).toISOString());
    },
  };
}

interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** The production counter: the atomic SQL function created by the quotes migration. */
export function rpcIncr(db: RpcClient): RateLimitOptions["incr"] {
  return async (key, expiresAtIso) => {
    const { data, error } = await db.rpc("quotes_rl_incr", { p_key: key, p_expires: expiresAtIso });
    if (error !== null || typeof data !== "number")
      throw new Error("rate_limit_counter_unavailable");
    return data;
  };
}

/** The production reader: the `hit_count` of a counter row in `quote_cache` (0 when the row does not exist yet). */
export function readCount(db: SupabaseClient): AcceptedCounterOptions["read"] {
  return async (key) => {
    const { data, error } = await db
      .from("quote_cache")
      .select("hit_count")
      .eq("key", key)
      .maybeSingle();
    if (error !== null) throw new Error("rate_limit_counter_unavailable");
    const n = (data as { hit_count?: unknown } | null)?.hit_count;
    return typeof n === "number" ? n : 0;
  };
}
