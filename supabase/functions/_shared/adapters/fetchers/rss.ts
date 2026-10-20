import { XMLParser } from "npm:fast-xml-parser@5.11.2";
import type { FetchLike } from "../llm/types.ts";
import { type DnsResolver, type DocFetchFail, fetchDocument } from "./direct.ts";

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  published: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value !== null && typeof value === "object")
    return text((value as Record<string, unknown>)["#text"]);
  return "";
}

function atomLink(value: unknown): string {
  const links = asArray(value).map((l) => (l ?? {}) as Record<string, unknown>);
  if (links.length === 0) return "";
  const alternate =
    links.find((l) => l["@_rel"] === undefined || l["@_rel"] === "alternate") ?? links[0];
  return text(alternate?.["@_href"]) || text(alternate);
}

function isoOrNull(value: string): string | null {
  if (value === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// biome-ignore lint/suspicious/noExplicitAny: fast-xml-parser output is untyped
type XmlDoc = Record<string, any>;

/** RSS 2.0 and Atom. Anything else (or malformed XML) yields no items. */
export function parseFeed(xml: string): FeedItem[] {
  let doc: XmlDoc;
  try {
    doc = parser.parse(xml) as XmlDoc;
  } catch {
    return [];
  }
  const items: FeedItem[] = [];
  for (const raw of asArray(doc?.rss?.channel?.item)) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const link = text(item.link);
    const title = text(item.title);
    items.push({
      guid: text(item.guid) || link || title,
      title,
      link,
      published: isoOrNull(text(item.pubDate) || text(item["dc:date"])),
    });
  }
  for (const raw of asArray(doc?.feed?.entry)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const link = atomLink(entry.link);
    const title = text(entry.title);
    items.push({
      guid: text(entry.id) || link || title,
      title,
      link,
      published: isoOrNull(text(entry.published) || text(entry.updated)),
    });
  }
  return items.filter((i) => i.guid !== "");
}

const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "text/plain",
]);

export interface FetchFeedOptions {
  fetchImpl?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  resolveDns?: DnsResolver | false | undefined;
}

/** Feed fetch through `fetchDocument`: manual redirects with the public-URL check on every hop, 15 s timeout, 2 MB cap. */
export async function fetchFeed(
  url: string,
  opts: FetchFeedOptions = {},
): Promise<
  | { ok: true; items: FeedItem[]; truncated: boolean }
  | { ok: false; kind: DocFetchFail["kind"]; status?: number | undefined; message: string }
> {
  const res = await fetchDocument(url, {
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 15_000,
    maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
    allowedTypes: FEED_TYPES,
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
    rawText: true,
    resolveDns: opts.resolveDns,
  });
  if (!res.ok) return { ok: false, kind: res.kind, status: res.status, message: res.message };
  return { ok: true, items: parseFeed(res.text ?? ""), truncated: res.truncated };
}
