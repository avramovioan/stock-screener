import { assert, assertEquals } from "jsr:@std/assert@1";
import type { FetchLike } from "../llm/types.ts";
import { fetchDocument, isSecHost, publicUrlProblem } from "./direct.ts";
import { noLimiter } from "./limiter.ts";

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    seen.push({ url, headers });
    return await handler(url, init ?? {});
  };
  return { fetchImpl, seen };
}

const html = (body: string, type = "text/html; charset=utf-8", status = 200) =>
  new Response(body, { status, headers: { "content-type": type } });

Deno.test("direct: extracts plain text from HTML", async () => {
  const { fetchImpl } = stub(() =>
    html("<html><script>x()</script><p>Hello &amp; welcome</p></html>"),
  );
  const res = await fetchDocument("https://investors.example.com/q3", { fetchImpl });
  assert(res.ok);
  assertEquals(res.text, "Hello & welcome");
  assertEquals(res.contentType, "text/html");
  assertEquals(res.truncated, false);
});

Deno.test("direct: a PDF is reported without text so the caller can route it to Jina", async () => {
  const { fetchImpl } = stub(
    () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
  );
  const res = await fetchDocument("https://example.com/report.pdf", { fetchImpl });
  assert(res.ok);
  assertEquals(res.text, null);
  assertEquals(res.contentType, "application/pdf");
});

Deno.test("direct: content types outside the allow-list are refused", async () => {
  const { fetchImpl } = stub(() => new Response("x", { headers: { "content-type": "image/png" } }));
  const res = await fetchDocument("https://example.com/a.png", { fetchImpl });
  assert(!res.ok);
  assertEquals(res.kind, "content_type");
});

Deno.test("direct: the body read is capped (default 2 MB, here 50 bytes)", async () => {
  const { fetchImpl } = stub(() => html("a".repeat(500), "text/plain"));
  const res = await fetchDocument("https://example.com/big.txt", { fetchImpl, maxBytes: 50 });
  assert(res.ok);
  assertEquals(res.text?.length, 50);
  assertEquals(res.truncated, true);
});

Deno.test("direct: SEC hosts require and send SEC_USER_AGENT and use the SEC limiter", async () => {
  let taken = 0;
  const limiter = {
    take: () => {
      taken++;
      return Promise.resolve();
    },
  };
  const { fetchImpl, seen } = stub(() => html("<p>filing</p>"));
  const refused = await fetchDocument("https://www.sec.gov/Archives/edgar/data/1/x.htm", {
    fetchImpl,
    limiter,
  });
  assert(!refused.ok);
  assertEquals(refused.kind, "blocked");
  assertEquals(seen.length, 0, "no request without a declared User-Agent");
  const res = await fetchDocument("https://www.sec.gov/Archives/edgar/data/1/x.htm", {
    fetchImpl,
    secUserAgent: "Screener admin@example.com",
    limiter,
  });
  assert(res.ok);
  assertEquals(seen[0]?.headers["user-agent"], "Screener admin@example.com");
  assertEquals(taken, 1);
  assert(isSecHost("data.sec.gov") && isSecHost("sec.gov") && !isSecHost("notsec.gov"));
});

Deno.test("direct: private and local targets are never requested, including via redirect", async () => {
  for (const bad of [
    "http://127.0.0.1/",
    "http://localhost/x",
    "http://169.254.169.254/latest",
    "http://10.0.0.5/",
    "http://[::1]/",
    "ftp://example.com/x",
    "http://intranet/x",
  ]) {
    assert(publicUrlProblem(bad) !== null, bad);
  }
  assertEquals(publicUrlProblem("https://investors.example.com/x"), null);
  const { fetchImpl, seen } = stub((url) =>
    url === "https://example.com/start"
      ? new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        })
      : html("secret"),
  );
  const res = await fetchDocument("https://example.com/start", { fetchImpl, limiter: noLimiter });
  assert(!res.ok);
  assertEquals(res.kind, "blocked");
  assertEquals(seen.length, 1);
});

Deno.test("direct: follows a public redirect and reports the final URL", async () => {
  const { fetchImpl } = stub((url) =>
    url === "https://example.com/old"
      ? new Response(null, { status: 301, headers: { location: "/new" } })
      : html("<p>moved</p>"),
  );
  const res = await fetchDocument("https://example.com/old", { fetchImpl });
  assert(res.ok);
  assertEquals(res.finalUrl, "https://example.com/new");
});

Deno.test("direct: 404 is http with the status; a hung server is a timeout", async () => {
  const notFound = stub(() => html("nope", "text/html", 404));
  const a = await fetchDocument("https://example.com/missing", { fetchImpl: notFound.fetchImpl });
  assert(!a.ok);
  assertEquals(a.kind, "http");
  assertEquals(a.status, 404);
  const hung = stub(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  const b = await fetchDocument("https://example.com/slow", {
    fetchImpl: hung.fetchImpl,
    timeoutMs: 20,
  });
  assert(!b.ok);
  assertEquals(b.kind, "timeout");
});

Deno.test("direct: trailing-dot hosts cannot dodge the local-host checks", () => {
  for (const bad of [
    "http://localhost./",
    "http://foo.localhost./",
    "http://x.local./",
    "http://metadata.google.internal./",
    "http://127.0.0.1./",
  ]) {
    assert(publicUrlProblem(bad) !== null, bad);
  }
  assertEquals(publicUrlProblem("https://investors.example.com./x"), null);
});

Deno.test("direct: reserved IPv4 and IPv6 ranges are not public", () => {
  for (const bad of [
    "http://0.0.0.0/",
    "http://0.1.2.3/",
    "http://192.0.0.8/",
    "http://198.18.0.1/",
    "http://198.19.255.254/",
    "http://224.0.0.1/",
    "http://239.255.255.250/",
    "http://240.0.0.1/",
    "http://255.255.255.255/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[::]/",
    "http://[::1]/",
    "http://2130706433/",
  ]) {
    assert(publicUrlProblem(bad) !== null, bad);
  }
  for (const good of ["https://8.8.8.8/", "http://198.20.0.1/", "http://[2606:4700::1111]/"]) {
    assertEquals(publicUrlProblem(good), null, good);
  }
});

Deno.test("direct: a host resolving to a non-public address is blocked; unavailable DNS is recorded as skipped", async () => {
  const ok = stub(() => html("<p>x</p>"));
  const rebinding = await fetchDocument("https://evil.example.com/", {
    fetchImpl: ok.fetchImpl,
    resolveDns: (_host, type) => Promise.resolve(type === "A" ? ["10.0.0.7"] : []),
  });
  assert(!rebinding.ok);
  assertEquals(rebinding.kind, "blocked");
  assertEquals(ok.seen.length, 0);
  const mappedV6 = await fetchDocument("https://evil2.example.com/", {
    fetchImpl: ok.fetchImpl,
    resolveDns: (_host, type) =>
      Promise.resolve(type === "AAAA" ? ["::ffff:7f00:1"] : ["93.184.216.34"]),
  });
  assert(!mappedV6.ok);
  const fine = await fetchDocument("https://fine.example.com/", {
    fetchImpl: ok.fetchImpl,
    resolveDns: () => Promise.resolve(["93.184.216.34"]),
  });
  assert(fine.ok);
  assertEquals(fine.dnsCheck, "ok");
  const denied = await fetchDocument("https://fine.example.com/", {
    fetchImpl: ok.fetchImpl,
    resolveDns: () => Promise.reject(new Error("PermissionDenied: net access")),
  });
  assert(denied.ok);
  assertEquals(denied.dnsCheck, "skipped");
  const none = await fetchDocument("https://fine.example.com/", { fetchImpl: ok.fetchImpl });
  assert(none.ok);
  assertEquals(none.dnsCheck, "skipped");
});
