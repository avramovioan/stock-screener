import type { Clock } from "./clock.ts";

/** Small key/value store with expiry. Production: public.quote_cache (see db.ts). Tests: in-memory. */
export interface KvStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createMemoryKv(clock: Clock): KvStore & { size(): number } {
  const map = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    get<T>(key: string): Promise<T | null> {
      const hit = map.get(key);
      if (hit === undefined || hit.expiresAt <= clock.now()) {
        map.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(structuredClone(hit.value) as T);
    },
    set(key, value, ttlMs) {
      map.set(key, { value: structuredClone(value), expiresAt: clock.now() + ttlMs });
      return Promise.resolve();
    },
    delete(key) {
      map.delete(key);
      return Promise.resolve();
    },
    size: () => map.size,
  };
}
