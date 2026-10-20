import { clientIp, hashIp } from "@adapters/rate-limit.ts";
import type { CacheStore } from "./cache.ts";

export const RATE_LIMIT_PER_MINUTE = 60;

export { clientIp, hashIp } from "@adapters/rate-limit.ts";

export async function checkRate(
  store: CacheStore,
  req: Request,
  salt: string,
  fn: string,
  nowMs: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const minute = Math.floor(nowMs / 60_000);
  const key = `rl:${fn}:${await hashIp(clientIp(req), salt, nowMs)}:${minute}`;
  const count = await store.incr(key, (minute + 2) * 60_000);
  return {
    allowed: count <= RATE_LIMIT_PER_MINUTE,
    retryAfterSec: Math.max(1, Math.ceil(((minute + 1) * 60_000 - nowMs) / 1000)),
  };
}
