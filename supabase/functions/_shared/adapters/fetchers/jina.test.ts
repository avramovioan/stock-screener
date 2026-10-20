import { assert, assertEquals } from "jsr:@std/assert@1";
import type { FetchLike } from "../llm/types.ts";
import { readerUrl, readViaJina } from "./jina.ts";
import { noLimiter } from "./limiter.ts";

function stub(res: () => Response) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    seen.push({ url: typeof input === "string" ? input : String(input), headers });
    return Promise.resolve(res());
  };
  return { fetchImpl, seen };
}

Deno.test("jina: readerUrl prefixes the target", () => {
  assertEquals(
    readerUrl("https://www.sec.gov/a.htm"),
    "https://r.jina.ai/https://www.sec.gov/a.htm",
  );
});

Deno.test("jina: returns text, sends a bearer only when a key exists", async () => {
  const keyed = stub(() => new Response("Title: X\n\nMarkdown Content:\nHello"));
  const a = await readViaJina("https://example.com/r.pdf", {
    apiKey: "JINA-KEY-1",
    fetchImpl: keyed.fetchImpl,
    limiter: noLimiter,
  });
  assert(a.ok);
  assert(a.text.includes("Hello"));
  assertEquals(keyed.seen[0]?.url, "https://r.jina.ai/https://example.com/r.pdf");
  assertEquals(keyed.seen[0]?.headers.authorization, "Bearer JINA-KEY-1");
  const keyless = stub(() => new Response("ok"));
  await readViaJina("https://example.com/r", { fetchImpl: keyless.fetchImpl, limiter: noLimiter });
  assertEquals(keyless.seen[0]?.headers.authorization, undefined);
});

Deno.test("jina: 429 is rate_limited, other errors http, private targets blocked without a request", async () => {
  const limited = stub(() => new Response("slow", { status: 429 }));
  const a = await readViaJina("https://example.com/r", {
    fetchImpl: limited.fetchImpl,
    limiter: noLimiter,
  });
  assert(!a.ok);
  assertEquals(a.kind, "rate_limited");
  const broken = stub(() => new Response("boom", { status: 502 }));
  const b = await readViaJina("https://example.com/r", {
    fetchImpl: broken.fetchImpl,
    limiter: noLimiter,
  });
  assert(!b.ok);
  assertEquals(b.kind, "http");
  const blocked = stub(() => new Response("never"));
  const c = await readViaJina("http://127.0.0.1/secret", {
    fetchImpl: blocked.fetchImpl,
    limiter: noLimiter,
  });
  assert(!c.ok);
  assertEquals(c.kind, "blocked");
  assertEquals(blocked.seen.length, 0);
});

Deno.test("jina: the body is read with a cap and a failing body stream is a network failure", async () => {
  const big = stub(() => new Response("x".repeat(5_000)));
  const ok = await readViaJina("https://example.com/r.pdf", {
    fetchImpl: big.fetchImpl,
    limiter: noLimiter,
    maxChars: 100,
  });
  assert(ok.ok);
  assertEquals(ok.text.length, 100);
  const broken = stub(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ab"));
            controller.error(new Error("socket reset"));
          },
        }),
      ),
  );
  const failed = await readViaJina("https://example.com/r.pdf", {
    fetchImpl: broken.fetchImpl,
    limiter: noLimiter,
  });
  assertEquals(failed.ok, false);
  if (!failed.ok) assertEquals(failed.kind, "network");
});
