export const MAX_SYMBOLS = 50;
const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;

export function normalizeSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

/** Search text: trimmed, single-spaced, 2-40 characters, no control characters or angle brackets. */
export function normalizeQuery(raw: string | null): string | null {
  if (raw === null) return null;
  const q = raw.trim().replace(/\s+/g, " ");
  if (q.length < 2 || q.length > 40) return null;
  // deno-lint-ignore no-control-regex
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f<>]/.test(q)) return null;
  return q;
}

export function parseSymbols(
  body: unknown,
): { ok: true; symbols: string[] } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null)
    return { ok: false, error: "body must be a JSON object" };
  const list = (body as { symbols?: unknown }).symbols;
  if (!Array.isArray(list) || list.length === 0)
    return { ok: false, error: "symbols must be a non-empty array" };
  if (list.length > MAX_SYMBOLS)
    return { ok: false, error: `at most ${MAX_SYMBOLS} symbols per request` };
  const out: string[] = [];
  for (const item of list) {
    const s = normalizeSymbol(item);
    if (s === null) return { ok: false, error: "invalid symbol" };
    if (!out.includes(s)) out.push(s);
  }
  return { ok: true, symbols: out };
}
