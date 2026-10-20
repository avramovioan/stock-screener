import type { LlmFailureKind } from "./types.ts";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export type ParsedJson = { ok: true; json: unknown } | { ok: false; message: string };

export function parseModelJson(text: string): ParsedJson {
  try {
    return { ok: true, json: JSON.parse(stripCodeFences(text)) };
  } catch (e) {
    return {
      ok: false,
      message: `model output is not valid JSON: ${(e as Error).message}`.slice(0, 200),
    };
  }
}

/** Removes secrets from a message and caps its length; error messages never carry a key. */
export function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 300);
}

export function errorMessage(e: unknown, secrets: readonly string[] = []): string {
  return redact(e instanceof Error ? e.message : String(e), secrets);
}

const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const UNAVAILABLE_BODY = /UNAVAILABLE|overloaded|high demand|DEADLINE_EXCEEDED/i;

/**
 * Maps an HTTP error body to a failure kind: 429 and exhausted-quota codes become quota or rate_limited.
 * Only a per-day marker (PerDay, per day, per-day, daily, (TPD), (RPD), insufficient_quota) makes it a daily quota.
 * "billing" and "exceeded your current quota" do not: Groq and Gemini per-minute messages carry both, so they stay rate_limited.
 */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
  secrets: readonly string[],
): { kind: LlmFailureKind; status: number; message: string } {
  let message = bodyText.slice(0, 300);
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      isPlainObject(parsed) &&
      isPlainObject(parsed.error) &&
      typeof parsed.error.message === "string"
    ) {
      message = parsed.error.message;
    } else if (isPlainObject(parsed) && typeof parsed.message === "string") {
      message = parsed.message; // Mistral: { object: "error", message, type, code }
    }
  } catch {
    // keep the raw (truncated) body
  }
  const exhausted =
    status === 429 || /RESOURCE_EXHAUSTED|insufficient_quota|rate_limit_exceeded/i.test(bodyText);
  let kind: LlmFailureKind = "http";
  if (exhausted) {
    kind = /PerDay|per[ -]day|daily|\(TPD\)|\(RPD\)|insufficient_quota/i.test(bodyText)
      ? "quota"
      : "rate_limited";
  }
  // 429 stays quota or rate_limited; any other transient capacity answer is "unavailable" (another provider may serve it)
  if (!exhausted && (UNAVAILABLE_STATUSES.has(status) || UNAVAILABLE_BODY.test(bodyText)))
    kind = "unavailable";
  return { kind, status, message: redact(message, secrets) };
}

/**
 * True when the request itself is too big for the provider, so resending it unchanged can never succeed:
 * HTTP 413, a "request too large" message, or a per-minute token error whose requested size exceeds the whole limit
 * (Groq: `Request too large for model ... on tokens per minute (TPM): Limit 8000, Requested 12345`).
 * A TPM 429 where the request fits the limit (the minute is merely used up) is NOT too large: it stays `rate_limited`.
 */
export function isRequestTooLarge(status: number, bodyText: string): boolean {
  if (status === 413) return true;
  if (/request too large|request entity too large|payload too large/i.test(bodyText)) return true;
  const m = /Limit\s+(\d+)\b[^.]*?\bRequested\s+(\d+)/i.exec(bodyText);
  return m !== null && Number(m[2]) > Number(m[1]);
}
