/**
 * Structured, redacted events for scan_events (7.9, 15.6). No secrets, tokens, e-mail addresses or portfolio contents may reach the table:
 * keys matching /token|secret|key|authorization|password|cookie|crumb|email|endpoint|p256dh|auth/i are replaced (spec 15.6), credentials in URL-like
 * strings are masked, e-mail addresses and long base64-like values inside strings are masked.
 */
export type EventLevel = "debug" | "info" | "warn" | "error";
export type JobStage =
  | "fx"
  | "universe_sweep"
  | "identity"
  | "volume_probe"
  | "fetch_bars"
  | "compute"
  | "rank_signals"
  | "portfolio_scan"
  | "news"
  | "research"
  | "classify"
  | "publish"
  | "digest"
  | "eur_catalogue"
  | "eur_resolve";

export interface ScanEventRow {
  runId: string | null;
  jobId: number | null;
  stage: JobStage | null;
  level: EventLevel;
  event: string;
  securityId: string | null;
  message: string | null;
  data: Record<string, unknown> | null;
}

export interface EventSink {
  recordEvent(e: ScanEventRow): Promise<void>;
}

export interface RunRef {
  runId: string | null;
  jobId?: number | null;
  stage?: JobStage | null;
}

export const REDACT_KEY =
  /token|secret|key|authorization|password|cookie|crumb|email|endpoint|p256dh|auth/i;
export const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_STRING = 2000;
const URL_CREDENTIAL = /([?&](?:crumb|key|token|apikey|api_key|access_token|secret)=)[^&\s"']+/gi;

const EMAIL_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_BLOB = /[A-Za-z0-9+/_-]{48,}={0,2}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@"']+@/gi;

export function redactString(s: string): string {
  const masked = s
    .replace(URL_CREDENTIAL, `$1${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(EMAIL_VALUE, "[redacted-email]")
    .replace(LONG_BLOB, (blob) => (/^[0-9a-f]+$/i.test(blob) ? blob : "[redacted-blob]"));
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}...[truncated]` : masked;
}

/** Deep copy with sensitive keys replaced. Never mutates its input; deep or cyclic structures are cut at depth 6. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export async function scanEvent(
  sink: EventSink,
  run: RunRef,
  event: string,
  data?: Record<string, unknown>,
  extra: { level?: EventLevel; securityId?: string | null; message?: string | null } = {},
): Promise<void> {
  await sink.recordEvent({
    runId: run.runId,
    jobId: run.jobId ?? null,
    stage: run.stage ?? null,
    level: extra.level ?? "info",
    event,
    securityId: extra.securityId ?? null,
    message:
      extra.message === undefined || extra.message === null
        ? null
        : redactString(extra.message).slice(0, 500),
    data: data === undefined ? null : (redact(data) as Record<string, unknown>),
  });
}

/** One redacted JSON line on stdout (function logs). Use instead of console.log(JSON.stringify(...)). */
export function logLine(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify(redact({ event, ...data })));
}

/** An error to stderr with the message redacted (URLs with keys, bearer tokens, e-mail addresses, long blobs). */
export function logError(label: string, e: unknown): void {
  console.error(label, redactString(e instanceof Error ? e.message : String(e)));
}
