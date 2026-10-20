export const DEFAULT_MAX_AGE_HOURS = 36;
export const DB_SIZE_ALERT_MB = 400;
export const MIN_COVERAGE = 0.9;

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const pick = (v: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => (isRec(acc) ? acc[key] : undefined), v);
const hoursSince = (iso: unknown, nowMs: number): number | null => {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (nowMs - t) / 3_600_000;
};

/** A skipped scan (no new completed session: Sunday, Monday morning, a US holiday) covers a last success at most this old. */
export const SKIP_COVERS_HOURS = 96;

/**
 * The real age of a scan timestamp (what a message prints) and the age the threshold compares: counted from the latest skipped scan
 * instead when that one is newer and the success is not older than SKIP_COVERS_HOURS ("nothing new to scan" is healthy, "the scan
 * stopped" is not). A missing timestamp stays missing.
 */
const ageWithSkip = (
  iso: unknown,
  status: unknown,
  nowMs: number,
): { age: number; effective: number } | null => {
  const age = hoursSince(iso, nowMs);
  if (age === null) return null;
  const skipAge = hoursSince(pick(status, "last_skipped", "at"), nowMs);
  const covered = skipAge !== null && skipAge < age && age <= SKIP_COVERS_HOURS;
  return { age, effective: covered ? skipAge : age };
};

export interface AlertInput {
  status: unknown;
  health: unknown;
  nowMs: number;
  maxAgeHours?: number;
}

/**
 * Spec 16.4 and 16.5 conditions that `scan_status` and `health` can evaluate: scan age, published age, coverage below 90%,
 * database above 400 MB, health not ok. Conditions that need fields `health` does not expose (breaker open for 1 h, deferred
 * research, failed deliveries) are manual checks in the operator guide.
 */
export function evaluateAlerts(i: AlertInput): string[] {
  const max = i.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const out: string[] = [];
  const finished = ageWithSkip(pick(i.status, "last_successful", "finished_at"), i.status, i.nowMs);
  if (finished === null) out.push("no successful scan on record");
  else if (finished.effective > max)
    out.push(`last successful scan finished ${finished.age.toFixed(1)} h ago (limit ${max} h)`);
  const published = ageWithSkip(
    pick(i.status, "latest_published", "results_published_at"),
    i.status,
    i.nowMs,
  );
  if (published === null) out.push("no published scan result on record");
  else if (published.effective > max)
    out.push(`latest published result is ${published.age.toFixed(1)} h old (limit ${max} h)`);
  const total = pick(i.status, "latest_published", "coverage", "candidates", "total");
  const processed = pick(i.status, "latest_published", "coverage", "candidates", "processed");
  const skipped = pick(i.status, "latest_published", "coverage", "candidates", "skipped");
  const insufficient = pick(
    i.status,
    "latest_published",
    "coverage",
    "candidates",
    "insufficient_data",
  );
  // The server's list_coverage: (processed + skipped + insufficient_data) / total.
  const covered =
    typeof processed === "number"
      ? processed +
        (typeof skipped === "number" ? skipped : 0) +
        (typeof insufficient === "number" ? insufficient : 0)
      : null;
  if (
    typeof total === "number" &&
    total > 0 &&
    covered !== null &&
    covered / total < MIN_COVERAGE
  ) {
    out.push(
      `list coverage ${((100 * covered) / total).toFixed(1)}% is below ${MIN_COVERAGE * 100}%`,
    );
  }
  if (pick(i.health, "ok") === false) out.push("health reports ok=false");
  const size = pick(i.health, "db", "size_mb");
  if (typeof size === "number" && size > DB_SIZE_ALERT_MB)
    out.push(`database size ${size} MB exceeds ${DB_SIZE_ALERT_MB} MB`);
  return out;
}
