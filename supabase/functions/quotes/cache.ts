import type { SupabaseClient } from "@supabase/supabase-js";

export interface CacheEntry {
  payload: unknown;
  fetchedAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

/** Backed by the `quote_cache` table in production and by memory in tests. Lock rows are `lock:<key>`. */
export interface CacheStore {
  /** Returns the entry even when expired (callers decide; stale-on-lock needs it). */
  get(key: string): Promise<CacheEntry | null>;
  put(key: string, payload: unknown, fetchedAt: number, expiresAt: number): Promise<void>;
  /** INSERT lock:<key> ON CONFLICT DO NOTHING; an expired lock is replaced. True when acquired. */
  tryLock(key: string, nowMs: number, ttlMs: number): Promise<boolean>;
  unlock(key: string): Promise<void>;
  /** Atomic increment of a counter row; returns the new count. */
  incr(key: string, expiresAt: number): Promise<number>;
  /** One round trip: entries (even expired) for the keys that exist. */
  getMany(keys: string[]): Promise<Map<string, CacheEntry>>;
  /** One round trip: per-key `tryLock` semantics; returns the keys whose lock was acquired. */
  tryLockMany(keys: string[], nowMs: number, ttlMs: number): Promise<Set<string>>;
  /** One round trip: upsert all entries. */
  putMany(entries: CachePut[]): Promise<void>;
  /** One round trip: release the locks of all keys. */
  unlockMany(keys: string[]): Promise<void>;
}

export interface CachePut {
  key: string;
  payload: unknown;
  fetchedAt: number;
  expiresAt: number;
}

export class MemoryCacheStore implements CacheStore {
  entries = new Map<string, CacheEntry>();
  counters = new Map<string, { n: number; expiresAt: number }>();
  /** Number of data-access calls (everything except incr); tests bound it. */
  calls = 0;

  getMany(keys: string[]): Promise<Map<string, CacheEntry>> {
    this.calls++;
    const out = new Map<string, CacheEntry>();
    for (const k of keys) {
      const e = this.entries.get(k);
      if (e) out.set(k, e);
    }
    return Promise.resolve(out);
  }
  tryLockMany(keys: string[], nowMs: number, ttlMs: number): Promise<Set<string>> {
    this.calls++;
    const got = new Set<string>();
    for (const key of keys) {
      const existing = this.entries.get(`lock:${key}`);
      if (existing && existing.expiresAt > nowMs) continue;
      this.entries.set(`lock:${key}`, {
        payload: null,
        fetchedAt: nowMs,
        expiresAt: nowMs + ttlMs,
      });
      got.add(key);
    }
    return Promise.resolve(got);
  }
  putMany(entries: CachePut[]): Promise<void> {
    this.calls++;
    for (const e of entries) {
      this.entries.set(e.key, {
        payload: e.payload,
        fetchedAt: e.fetchedAt,
        expiresAt: e.expiresAt,
      });
    }
    return Promise.resolve();
  }
  unlockMany(keys: string[]): Promise<void> {
    this.calls++;
    for (const k of keys) this.entries.delete(`lock:${k}`);
    return Promise.resolve();
  }

  get(key: string): Promise<CacheEntry | null> {
    this.calls++;
    return Promise.resolve(this.entries.get(key) ?? null);
  }
  put(key: string, payload: unknown, fetchedAt: number, expiresAt: number): Promise<void> {
    this.calls++;
    this.entries.set(key, { payload, fetchedAt, expiresAt });
    return Promise.resolve();
  }
  tryLock(key: string, nowMs: number, ttlMs: number): Promise<boolean> {
    this.calls++;
    const k = `lock:${key}`;
    const existing = this.entries.get(k);
    if (existing && existing.expiresAt > nowMs) return Promise.resolve(false);
    this.entries.set(k, { payload: null, fetchedAt: nowMs, expiresAt: nowMs + ttlMs });
    return Promise.resolve(true);
  }
  unlock(key: string): Promise<void> {
    this.calls++;
    this.entries.delete(`lock:${key}`);
    return Promise.resolve();
  }
  incr(key: string, expiresAt: number): Promise<number> {
    const n = (this.counters.get(key)?.n ?? 0) + 1;
    this.counters.set(key, { n, expiresAt });
    return Promise.resolve(n);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export class SupabaseCacheStore implements CacheStore {
  constructor(private readonly db: SupabaseClient) {}

  async get(key: string): Promise<CacheEntry | null> {
    const { data, error } = await this.db
      .from("quote_cache")
      .select("payload,fetched_at,expires_at")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error(`cache get failed: ${error.message}`);
    return data
      ? {
          payload: data.payload,
          fetchedAt: Date.parse(data.fetched_at),
          expiresAt: Date.parse(data.expires_at),
        }
      : null;
  }

  async put(key: string, payload: unknown, fetchedAt: number, expiresAt: number): Promise<void> {
    const { error } = await this.db
      .from("quote_cache")
      .upsert(
        { key, payload, provider: "yahoo", fetched_at: iso(fetchedAt), expires_at: iso(expiresAt) },
        { onConflict: "key" },
      );
    if (error) throw new Error(`cache put failed: ${error.message}`);
  }

  async tryLock(key: string, nowMs: number, ttlMs: number): Promise<boolean> {
    const lockKey = `lock:${key}`;
    await this.db.from("quote_cache").delete().eq("key", lockKey).lt("expires_at", iso(nowMs));
    const { data, error } = await this.db
      .from("quote_cache")
      .upsert(
        {
          key: lockKey,
          payload: {},
          provider: "yahoo",
          fetched_at: iso(nowMs),
          expires_at: iso(nowMs + ttlMs),
        },
        { onConflict: "key", ignoreDuplicates: true },
      )
      .select("key");
    if (error) throw new Error(`cache lock failed: ${error.message}`);
    return (data?.length ?? 0) === 1; // ON CONFLICT DO NOTHING returns no row when the lock exists
  }

  async unlock(key: string): Promise<void> {
    await this.db.from("quote_cache").delete().eq("key", `lock:${key}`);
  }

  async incr(key: string, expiresAt: number): Promise<number> {
    const { data, error } = await this.db.rpc("quotes_rl_incr", {
      p_key: key,
      p_expires: iso(expiresAt),
    });
    if (error) throw new Error(`rate counter failed: ${error.message}`);
    return Number(data);
  }

  async getMany(keys: string[]): Promise<Map<string, CacheEntry>> {
    const out = new Map<string, CacheEntry>();
    if (keys.length === 0) return out;
    const { data, error } = await this.db
      .from("quote_cache")
      .select("key,payload,fetched_at,expires_at")
      .in("key", keys);
    if (error) throw new Error(`cache getMany failed: ${error.message}`);
    for (const r of data ?? []) {
      out.set(r.key, {
        payload: r.payload,
        fetchedAt: Date.parse(r.fetched_at),
        expiresAt: Date.parse(r.expires_at),
      });
    }
    return out;
  }

  async tryLockMany(keys: string[], nowMs: number, ttlMs: number): Promise<Set<string>> {
    const got = new Set<string>();
    if (keys.length === 0) return got;
    const lockKeys = keys.map((k) => `lock:${k}`);
    await this.db.from("quote_cache").delete().in("key", lockKeys).lt("expires_at", iso(nowMs));
    const { data, error } = await this.db
      .from("quote_cache")
      .upsert(
        lockKeys.map((key) => ({
          key,
          payload: {},
          provider: "yahoo",
          fetched_at: iso(nowMs),
          expires_at: iso(nowMs + ttlMs),
        })),
        { onConflict: "key", ignoreDuplicates: true },
      )
      .select("key");
    if (error) throw new Error(`cache lock failed: ${error.message}`);
    for (const r of data ?? []) got.add(r.key.slice("lock:".length));
    return got;
  }

  async putMany(entries: CachePut[]): Promise<void> {
    if (entries.length === 0) return;
    const { error } = await this.db.from("quote_cache").upsert(
      entries.map((e) => ({
        key: e.key,
        payload: e.payload,
        provider: "yahoo",
        fetched_at: iso(e.fetchedAt),
        expires_at: iso(e.expiresAt),
      })),
      { onConflict: "key" },
    );
    if (error) throw new Error(`cache putMany failed: ${error.message}`);
  }

  async unlockMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db
      .from("quote_cache")
      .delete()
      .in(
        "key",
        keys.map((k) => `lock:${k}`),
      );
  }
}
