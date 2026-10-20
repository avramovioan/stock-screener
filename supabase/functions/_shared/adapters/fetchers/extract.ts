const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Regex-based HTML to text: drops scripts, styles, comments and tags, keeps block structure as newlines. */
export function htmlToText(html: string): string {
  const withoutTags = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** About 12k tokens (48,000 characters) per document. */
export function capText(text: string, maxChars = 48_000): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Lower-case host (the URL parser does it), no fragment, no `utm_*`, `fbclid`, `gclid`, remaining params sorted. */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  url.hash = "";
  const kept: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || lower === "fbclid" || lower === "gclid") continue;
    kept.push([key, value]);
  }
  kept.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.href;
}
