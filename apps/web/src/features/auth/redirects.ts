const DUMMY_ORIGIN = "https://app.invalid";
const MAX_LENGTH = 512;

/** Backslash, ASCII control characters and DEL. Browsers drop tabs and newlines inside URLs. */
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * The only function allowed to turn untrusted input (the `next` search parameter) into a
 * navigation target. Returns an internal path or "/". Never an absolute URL.
 */
export function safeNext(raw: string | undefined | null): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || hasForbiddenChar(raw)) return "/";
  if (/%2e/i.test(raw) || /%5c/i.test(raw)) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (decoded.startsWith("//") || hasForbiddenChar(decoded)) return "/";
  let url: URL;
  try {
    url = new URL(raw, DUMMY_ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== DUMMY_ORIGIN) return "/";
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return "/";
  // Dot-segments are normalised by URL, so re-validate the normalised result.
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return "/";
  }
  if (decodedPath.includes("//") || decodedPath.includes("\\")) return "/";
  const out = `${url.pathname}${url.search}${url.hash}`;
  if (!out.startsWith("/") || out.startsWith("//") || out.startsWith("/\\")) return "/";
  return out;
}

/** Search object for a link or redirect that carries `next` (omitted for the default target). */
export function nextSearch(target: string): { next?: string } {
  return target === "/" ? {} : { next: target };
}
