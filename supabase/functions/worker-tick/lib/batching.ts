import type { SeedPlan } from "../types.ts";

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!(size >= 1)) throw new RangeError("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `<prefix>:<n>` jobs of `size` ids each; the payload carries the ids so a retry always processes the same batch. */
export function batchPlan(
  prefix: string,
  ids: readonly string[],
  size: number,
  priority = 100,
): SeedPlan {
  const batches = chunk(ids, size);
  return {
    keys: batches.map((_, n) => `${prefix}:${n}`),
    payloads: batches.map((securityIds) => ({ securityIds })),
    priorities: batches.map(() => priority),
  };
}

/** Exchange job key: the plain code for the first pages, `<code>@<offset>` for a follow-up job (spec 7.5 rule 3). */
export function sweepKey(code: string, offset: number): string {
  return offset === 0 ? code : `${code}@${offset}`;
}

export type SweepKey = { kind: "recheck" } | { kind: "exchange"; code: string; offset: number };

export function parseSweepKey(key: string): SweepKey {
  if (key.startsWith("recheck:")) return { kind: "recheck" };
  const at = key.indexOf("@");
  if (at < 0) return { kind: "exchange", code: key, offset: 0 };
  return { kind: "exchange", code: key.slice(0, at), offset: Number(key.slice(at + 1)) };
}

/** Exchange code a sweep job belongs to (null for the recheck job); used by the coverage object. */
export function exchangeOfSweepKey(key: string): string | null {
  const parsed = parseSweepKey(key);
  return parsed.kind === "exchange" ? parsed.code : null;
}
