import type { ScanStatus } from "@/features/screening/types";

export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
/** A skipped scan (no new market close) covers a last success at most this old (mirrors tools/lib/alerts.ts). */
export const SKIP_COVERS_MS = 96 * 60 * 60 * 1000;

export type ScanBanner =
  | { state: "ok" | "none" }
  | {
      state: "partial" | "failed";
      processed?: number;
      total?: number;
      insufficientData?: number;
      skipped?: number;
    }
  | {
      state: "stale";
      processed?: number;
      total?: number;
      insufficientData?: number;
      skipped?: number;
      lastScanAt: string;
      sessionDate: string | null;
      ageHours: number;
    };

/** Priority: failed, partial, stale, ok. An attempt time is never treated as success. */
export function deriveScanBanner(status: ScanStatus | undefined, nowMs: number): ScanBanner {
  if (!status) return { state: "none" };
  const {
    last_attempted: attempted,
    last_successful: success,
    latest_published: published,
  } = status;
  if (!success && !published) return { state: "none" };
  const cand = published?.coverage?.candidates;
  const counts = cand
    ? {
        processed: cand.processed,
        total: cand.total,
        ...(cand.insufficient_data === undefined
          ? {}
          : { insufficientData: cand.insufficient_data }),
        ...(cand.skipped === undefined ? {} : { skipped: cand.skipped }),
      }
    : {};
  if (attempted?.status === "failed") return { state: "failed", ...counts };
  if (published?.status === "partial" || published?.coverage?.publish?.list === false) {
    return { state: "partial", ...counts };
  }
  if (!success) return { state: "partial", ...counts };
  const ageMs = nowMs - Date.parse(success.finished_at);
  // "Nothing new to scan" is healthy: a skip newer than the last success counts as fresh, up to the cap.
  const skipMs = status.last_skipped ? nowMs - Date.parse(status.last_skipped.at) : Number.NaN;
  const covered = Number.isFinite(skipMs) && skipMs < ageMs && ageMs <= SKIP_COVERS_MS;
  if ((covered ? skipMs : ageMs) > STALE_AFTER_MS) {
    return {
      state: "stale",
      ...counts,
      lastScanAt: success.finished_at,
      sessionDate: published?.latest_session_date ?? null,
      ageHours: Math.floor(ageMs / 3_600_000),
    };
  }
  return { state: "ok" };
}
