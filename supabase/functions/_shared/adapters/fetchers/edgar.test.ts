import { assert, assertEquals } from "jsr:@std/assert@1";
import type { FetchLike } from "../llm/types.ts";
import { createEdgarClient, resetTickerCache } from "./edgar.ts";

const TICKERS = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
};

const SUBMISSIONS = {
  cik: "0000320193",
  filings: {
    recent: {
      accessionNumber: ["0000320193-26-000100", "0000320193-26-000090", "0000320193-25-000123"],
      filingDate: ["2026-10-02", "2026-08-01", "2025-11-01"],
      reportDate: ["2026-09-30", "2026-06-27", "2025-09-27"],
      form: ["8-K", "10-Q", "10-K"],
      primaryDocument: ["a8k.htm", "a10q.htm", "a10k.htm"],
    },
  },
};

function stub() {
  const seen: { url: string; ua: string | undefined }[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    seen.push({ url, ua: new Headers(init?.headers).get("user-agent") ?? undefined });
    if (url.endsWith("company_tickers.json")) return Promise.resolve(Response.json(TICKERS));
    if (url.includes("/submissions/CIK0000320193.json"))
      return Promise.resolve(Response.json(SUBMISSIONS));
    return Promise.resolve(new Response("nf", { status: 404 }));
  };
  return { fetchImpl, seen };
}

const UA = "Screener admin@example.com";
const limiter = { take: () => Promise.resolve() };

Deno.test("edgar: resolveCik maps a ticker to a zero-padded CIK, caches the file, and sends the User-Agent", async () => {
  resetTickerCache();
  const { fetchImpl, seen } = stub();
  const edgar = createEdgarClient({ userAgent: UA, fetchImpl, limiter });
  const aapl = await edgar.resolveCik("aapl");
  assert(aapl.ok);
  assertEquals(aapl.value, "0000320193");
  const brk = await edgar.resolveCik("BRK-B");
  assert(brk.ok);
  assertEquals(brk.value, "0001067983");
  const none = await edgar.resolveCik("ZZZZ");
  assert(none.ok);
  assertEquals(none.value, null);
  assertEquals(
    seen.filter((s) => s.url.endsWith("company_tickers.json")).length,
    1,
    "tickers file fetched once",
  );
  assertEquals(seen[0]?.ua, UA);
});

Deno.test("edgar: submissions returns recent filings and filingUrl builds the archive URL", async () => {
  const { fetchImpl } = stub();
  const edgar = createEdgarClient({ userAgent: UA, fetchImpl, limiter });
  const res = await edgar.submissions("0000320193");
  assert(res.ok);
  assertEquals(res.value.length, 3);
  assertEquals(res.value[0], {
    form: "8-K",
    accession: "0000320193-26-000100",
    filingDate: "2026-10-02",
    primaryDocument: "a8k.htm",
    reportDate: "2026-09-30",
  });
  assertEquals(
    edgar.filingUrl("0000320193", "0000320193-26-000090", "a10q.htm"),
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000090/a10q.htm",
  );
});

Deno.test("edgar: no User-Agent means no request", async () => {
  resetTickerCache();
  const { fetchImpl, seen } = stub();
  const edgar = createEdgarClient({ userAgent: "  ", fetchImpl, limiter });
  const a = await edgar.resolveCik("AAPL");
  assert(!a.ok);
  assertEquals(a.kind, "not_configured");
  const b = await edgar.submissions("0000320193");
  assert(!b.ok);
  assertEquals(b.kind, "not_configured");
  assertEquals(seen.length, 0);
});

Deno.test("edgar: every request passes through the limiter; HTTP errors are reported", async () => {
  resetTickerCache();
  let taken = 0;
  const counting = {
    take: () => {
      taken++;
      return Promise.resolve();
    },
  };
  const { fetchImpl } = stub();
  const edgar = createEdgarClient({ userAgent: UA, fetchImpl, limiter: counting });
  await edgar.submissions("0000320193");
  const missing = await edgar.submissions("0000000001");
  assertEquals(taken, 2);
  assert(!missing.ok);
  assertEquals(missing.kind, "http");
  assertEquals(missing.status, 404);
});
