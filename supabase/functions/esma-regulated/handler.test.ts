import { assertEquals } from "@std/assert";
import { MemoryCacheStore } from "../quotes/cache.ts";
import { type HandlerDeps, handle } from "./handler.ts";

const SITE = "https://screener.example.com";
const T0 = Date.UTC(2026, 10, 6, 8, 0, 0);
const ENDPOINT = "https://proj.supabase.co/functions/v1/esma-regulated";
const ISIN = "IE00BMFKG444";

const venue = (mic: string, name: string, label = "Regulated market") => ({
  ae_micLeiEsmaId: mic,
  ae_entityName: name,
  ae_entityTypeLabel: label,
  ae_status: "Active",
});
const reply = (docs: unknown[]) =>
  new Response(JSON.stringify({ response: { numFound: docs.length, docs } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

type Route = (req: { solr: boolean; core: string; q: string; segMic?: string }) => Response;

const coreOf = (
  url: string,
  body: string | undefined,
): { solr: boolean; core: string; q: string; segMic?: string } => {
  if (url.includes("/solr/")) {
    const u = new URL(url);
    return {
      solr: true,
      core: u.pathname.split("/")[2] as string,
      q: u.searchParams.get("q") ?? "",
    };
  }
  const b = JSON.parse(body ?? "{}") as {
    core: string;
    criteria: { name: string; value: string }[];
  };
  return {
    solr: false,
    core: b.core,
    q: "",
    segMic: b.criteria.find((c) => c.name === "mic")?.value,
  };
};

function setup(route: Route, over: Partial<HandlerDeps> = {}) {
  const sent: ReturnType<typeof coreOf>[] = [];
  const deps: HandlerDeps = {
    fetch: (url, init) => {
      const c = coreOf(url, typeof init.body === "string" ? init.body : undefined);
      sent.push(c);
      try {
        return Promise.resolve(route(c));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    store: new MemoryCacheStore(),
    verifier: {
      verify: (jwt) => Promise.resolve(jwt === "good.jwt.token" ? { userId: "u1" } : null),
    },
    now: () => T0,
    siteOrigin: SITE,
    rateLimitSalt: "test-salt-test-salt-test-salt-1234",
    ...over,
  };
  const post = (body: unknown, raw?: string, token: string | null = "good.jwt.token") =>
    handle(
      new Request(ENDPOINT, {
        method: "POST",
        body: raw ?? JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.5",
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      }),
      deps,
    );
  return { deps, sent, post };
}

const xetraVenues = [
  venue("FRAA", "Börse Frankfurt"),
  venue("XETU", "Xetra Off-Book"),
  venue("XETA", "Xetra"),
  venue("XEMA", "Xetra Main"),
];
const FIRDS = "esma_registers_firds";
const UPREG = "esma_registers_upreg";

Deno.test("regulated via Solr: one FIRDS request for all segments, first in try order wins", async () => {
  const s = setup((r) => {
    if (r.core === UPREG) return reply(xetraVenues);
    return reply([
      { isin: ISIN, mic: "XEMA", gnr_full_name: "Later" },
      { isin: ISIN, mic: "XETA", gnr_full_name: "Some ETF" },
    ]);
  });
  const res = await s.post({ isin: ` ${ISIN.toLowerCase()} `, mic: "xetr" });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.verdict, "regulated");
  assertEquals(body.source, "solr");
  assertEquals(body.mic, "XETR");
  assertEquals(body.exchangeName, "Deutsche Börse Xetra");
  assertEquals(body.matchedSegment, { mic: "XETA", name: "Xetra" });
  assertEquals(body.instrumentName, "Some ETF");
  assertEquals(
    body.regulatedSegments.map((x: { mic: string }) => x.mic),
    ["XETA", "XEMA", "XETU"],
  );
  assertEquals(body.checkedSegments, ["XETA", "XEMA", "XETU"]);
  const firds = s.sent.filter((c) => c.core === FIRDS);
  assertEquals(firds.length, 1);
  assertEquals(
    firds[0]?.q,
    `isin:${ISIN} AND latest_received_flag:1 AND mic:(XETA OR XEMA OR XETU)`,
  );
  assertEquals(
    s.sent.every((c) => c.solr),
    true,
  );
  assertEquals(typeof body.checkedAt, "string");
});

Deno.test("not-offered via Solr", async () => {
  const s = setup((r) =>
    r.core === UPREG ? reply(xetraVenues) : reply([{ isin: ISIN, mic: "XETB" }]),
  );
  const body = await (await s.post({ isin: ISIN, mic: "XETR" })).json();
  assertEquals(body.verdict, "not-offered");
  assertEquals(body.checkedSegments, ["XETA", "XEMA", "XETU"]);
  assertEquals(body.matchedSegment, null);
});

Deno.test("fallback: Solr failure switches to doMainSearch, per segment, stopping at the first hit", async () => {
  const s = setup((r) => {
    if (r.solr) return new Response("<html>nope</html>", { status: 200 });
    if (r.core === UPREG) return reply(xetraVenues);
    return r.segMic === "XEMA"
      ? reply([{ isin: ISIN, mic: "XEMA", gnr_full_name: "N" }])
      : reply([]);
  });
  const body = await (await s.post({ isin: ISIN, mic: "XETR" })).json();
  assertEquals(body.verdict, "regulated");
  assertEquals(body.source, "search");
  assertEquals(body.matchedSegment.mic, "XEMA");
  assertEquals(body.checkedSegments, ["XETA", "XEMA"]);
  // Solr is tried once, then never again in the same request.
  assertEquals(s.sent.filter((c) => c.solr).length, 1);
});

Deno.test("no-regulated-segment: no FIRDS calls", async () => {
  const s = setup((r) => {
    if (r.core === FIRDS) throw new Error("must not query FIRDS");
    return reply([venue("XETB", "Xetra MTF", "Multilateral trading facility")]);
  });
  const body = await (await s.post({ isin: ISIN, mic: "XETR" })).json();
  assertEquals(body.verdict, "no-regulated-segment");
  assertEquals(body.checkedSegments, []);
});

Deno.test("not-in-esma: venues register has none of the exchange's MICs", async () => {
  const s = setup(() => reply([venue("FRAA", "Börse Frankfurt")]));
  const body = await (await s.post({ isin: ISIN, mic: "XLON" })).json();
  assertEquals(body.verdict, "not-in-esma");
  assertEquals(body.regulatedSegments, []);
});

Deno.test("401 without a valid user token, before any ESMA call", async () => {
  const s = setup(() => reply([]));
  for (const token of [null, "bad.jwt.token"]) {
    const res = await s.post({ isin: ISIN, mic: "XETR" }, undefined, token);
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "unauthorized");
  }
  assertEquals(s.sent.length, 0);
});

Deno.test("400 for invalid JSON, invalid ISIN and unknown MIC", async () => {
  const s = setup(() => reply([]));
  assertEquals((await s.post(null, "{nope")).status, 400);
  assertEquals((await s.post({ isin: "IE00BMFKG445", mic: "XETR" })).status, 400);
  assertEquals((await s.post({ isin: ISIN, mic: "ZZZZ" })).status, 400);
  assertEquals((await s.post({ isin: ISIN })).status, 400);
  assertEquals(s.sent.length, 0);
});

Deno.test("405 for GET; OPTIONS honours only the site origin", async () => {
  const s = setup(() => reply([]));
  assertEquals((await handle(new Request(ENDPOINT, { method: "GET" }), s.deps)).status, 405);
  const ok = await handle(
    new Request(ENDPOINT, { method: "OPTIONS", headers: { origin: SITE } }),
    s.deps,
  );
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), SITE);
  const bad = await handle(
    new Request(ENDPOINT, { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
    s.deps,
  );
  assertEquals(bad.status, 403);
});

Deno.test("502 esma-unavailable when Solr and the fallback both fail", async () => {
  for (const make of [
    () => new Response("<html>captcha</html>", { status: 200 }),
    () => new Response("{}", { status: 503 }),
    () => {
      throw new Error("timeout");
    },
  ]) {
    const s = setup(make);
    const res = await s.post({ isin: ISIN, mic: "XETR" });
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error, "esma-unavailable");
    assertEquals(typeof body.manualUrls.venues, "string");
    assertEquals(typeof body.manualUrls.instruments, "string");
    assertEquals(s.sent.some((c) => c.solr) && s.sent.some((c) => !c.solr), true);
  }
});

Deno.test("429 after the per-minute limit", async () => {
  const s = setup(() => reply([venue("FRAA", "x")]));
  let last = 200;
  for (let i = 0; i < 61; i++) last = (await s.post({ isin: ISIN, mic: "XLON" })).status;
  assertEquals(last, 429);
});

Deno.test("rate limiter failure fails open", async () => {
  const store = new MemoryCacheStore();
  store.incr = () => Promise.reject(new Error("db down"));
  const s = setup(() => reply([venue("FRAA", "x")]), { store });
  assertEquals((await s.post({ isin: ISIN, mic: "XLON" })).status, 200);
});
