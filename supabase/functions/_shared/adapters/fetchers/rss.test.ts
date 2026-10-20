import { assert, assertEquals } from "jsr:@std/assert@1";
import type { FetchLike } from "../llm/types.ts";
import { fetchFeed, parseFeed } from "./rss.ts";

const RSS2 = `<?xml version="1.0"?><rss version="2.0"><channel><title>IR</title>
<item><title><![CDATA[Q3 results & outlook]]></title><link>https://ir.example.com/q3</link>
<guid isPermaLink="false">ir-2026-q3</guid><pubDate>Thu, 15 Oct 2026 06:00:00 GMT</pubDate></item>
<item><title>No guid here</title><link>https://ir.example.com/nogu</link><pubDate>garbage</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Filings</title>
<entry><title>8-K filing</title><id>urn:tag:1</id>
<link rel="self" href="https://x.example/self"/><link rel="alternate" href="https://x.example/8k"/>
<updated>2026-10-14T10:00:00Z</updated></entry>
<entry><title>Single entry no id</title><link href="https://x.example/only"/><published>2026-10-01T00:00:00Z</published></entry>
</feed>`;

Deno.test("rss: parses RSS 2.0 items, CDATA titles and guid objects, falls back to the link", () => {
  const items = parseFeed(RSS2);
  assertEquals(items.length, 2);
  assertEquals(items[0], {
    guid: "ir-2026-q3",
    title: "Q3 results & outlook",
    link: "https://ir.example.com/q3",
    published: "2026-10-15T06:00:00.000Z",
  });
  assertEquals(items[1]?.guid, "https://ir.example.com/nogu");
  assertEquals(items[1]?.published, null);
});

Deno.test("rss: parses Atom entries and prefers the alternate link", () => {
  const items = parseFeed(ATOM);
  assertEquals(items.length, 2);
  assertEquals(items[0], {
    guid: "urn:tag:1",
    title: "8-K filing",
    link: "https://x.example/8k",
    published: "2026-10-14T10:00:00.000Z",
  });
  assertEquals(items[1]?.link, "https://x.example/only");
  assertEquals(items[1]?.guid, "https://x.example/only");
});

Deno.test("rss: malformed or unrelated XML yields no items instead of throwing", () => {
  assertEquals(parseFeed("<html><body>not a feed</body></html>"), []);
  assertEquals(parseFeed("not xml at all"), []);
  assertEquals(parseFeed(""), []);
});

const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>A</title><link>https://ir.example.com/a</link></item></channel></rss>`;
const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/rss+xml" } });

function feedStub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    seen.push(url);
    return await handler(url, init ?? {});
  };
  return { fetchImpl, seen };
}

Deno.test("rss: fetchFeed rejects a redirect to a private host without requesting it", async () => {
  const { fetchImpl, seen } = feedStub((url) =>
    url === "https://ir.example.com/feed"
      ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
      : xml(FEED_XML),
  );
  const res = await fetchFeed("https://ir.example.com/feed", { fetchImpl });
  assert(!res.ok);
  assertEquals(res.kind, "blocked");
  assertEquals(seen, ["https://ir.example.com/feed"]);
});

Deno.test("rss: fetchFeed follows a public redirect once and parses the feed", async () => {
  const { fetchImpl, seen } = feedStub((url) =>
    url === "https://ir.example.com/feed"
      ? new Response(null, {
          status: 301,
          headers: { location: "https://cdn.example.net/feed.xml" },
        })
      : xml(FEED_XML),
  );
  const res = await fetchFeed("https://ir.example.com/feed", { fetchImpl });
  assert(res.ok);
  assertEquals(res.items.length, 1);
  assertEquals(res.items[0]?.link, "https://ir.example.com/a");
  assertEquals(seen, ["https://ir.example.com/feed", "https://cdn.example.net/feed.xml"]);
});

Deno.test("rss: fetchFeed reports a typed timeout and caps an oversized body", async () => {
  const hung = feedStub(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  const a = await fetchFeed("https://ir.example.com/slow", {
    fetchImpl: hung.fetchImpl,
    timeoutMs: 20,
  });
  assert(!a.ok);
  assertEquals(a.kind, "timeout");
  const big = feedStub(() => xml(FEED_XML + " ".repeat(5000)));
  const b = await fetchFeed("https://ir.example.com/big", {
    fetchImpl: big.fetchImpl,
    maxBytes: 100,
  });
  assert(b.ok);
  assertEquals(b.truncated, true);
  const bad = feedStub(() => new Response("x", { headers: { "content-type": "image/png" } }));
  const c = await fetchFeed("https://ir.example.com/img", { fetchImpl: bad.fetchImpl });
  assert(!c.ok);
  assertEquals(c.kind, "content_type");
});
