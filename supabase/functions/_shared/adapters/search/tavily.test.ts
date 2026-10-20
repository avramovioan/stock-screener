import { assert, assertEquals } from "jsr:@std/assert@1";
import type { FetchLike } from "../llm/types.ts";
import { createTavilyClient } from "./tavily.ts";

function stub(respond: () => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(respond());
  };
  return { fetchImpl, calls };
}

Deno.test("tavily: posts a basic search with the documented parameters and maps results", async () => {
  const { fetchImpl, calls } = stub(() =>
    Response.json({
      results: [
        {
          title: "Annual report",
          url: "https://ir.example.com/ar",
          content: "Revenue grew.",
          published_date: "2026-03-01",
        },
        { title: "No date", url: "https://news.example.com/x", content: "Shares fell." },
        { title: "Broken", content: "no url" },
      ],
    }),
  );
  const client = createTavilyClient({ apiKey: "TVLY-KEY-1", fetchImpl });
  const res = await client.search("Acme ACME annual report 2025 investor relations");
  assert(res.ok);
  assertEquals(res.results, [
    {
      url: "https://ir.example.com/ar",
      title: "Annual report",
      snippet: "Revenue grew.",
      publishedDate: "2026-03-01",
    },
    { url: "https://news.example.com/x", title: "No date", snippet: "Shares fell." },
  ]);
  assertEquals(calls[0]?.url, "https://api.tavily.com/search");
  assertEquals(calls[0]?.body, {
    api_key: "TVLY-KEY-1",
    query: "Acme ACME annual report 2025 investor relations",
    search_depth: "basic",
    max_results: 5,
    include_answer: false,
  });
});

Deno.test("tavily: 429 is rate_limited, 432/433 are quota, a missing key is not_configured", async () => {
  const k = (status: number) =>
    createTavilyClient({
      apiKey: "TVLY-KEY-1",
      fetchImpl: stub(() => new Response("x", { status })).fetchImpl,
    });
  const a = await k(429).search("q");
  assert(!a.ok);
  assertEquals(a.kind, "rate_limited");
  const b = await k(432).search("q");
  assert(!b.ok);
  assertEquals(b.kind, "quota");
  const c = await k(433).search("q");
  assert(!c.ok);
  assertEquals(c.kind, "quota");
  const d = await k(500).search("q");
  assert(!d.ok);
  assertEquals(d.kind, "http");
  const s = stub(() => Response.json({ results: [] }));
  const none = await createTavilyClient({ fetchImpl: s.fetchImpl }).search("q");
  assert(!none.ok);
  assertEquals(none.kind, "not_configured");
  assertEquals(s.calls.length, 0);
});

Deno.test("tavily: a network failure never echoes the key", async () => {
  const fetchImpl: FetchLike = () => Promise.reject(new Error("dns failure for TVLY-KEY-1"));
  const res = await createTavilyClient({ apiKey: "TVLY-KEY-1", fetchImpl }).search("q");
  assert(!res.ok);
  assertEquals(res.kind, "network");
  assert(!res.message.includes("TVLY-KEY-1"));
});
