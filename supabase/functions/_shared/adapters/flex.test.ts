import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createFlexClient,
  createRpcLimiter,
  FlexLimiterError,
  flexClientFromEnv,
  tokenKey,
} from "./flex.ts";

const TOKEN = "987654321012345678901234";

const SEND_OK = `<FlexStatementResponse timestamp='15 October, 2026 03:05 AM EDT'><Status>Success</Status><ReferenceCode>1234567890</ReferenceCode><Url>https://example.invalid/never-fetched</Url></FlexStatementResponse>`;
const fail = (code: number, message: string, status = "Fail") =>
  `<FlexStatementResponse timestamp='15 October, 2026 03:05 AM EDT'><Status>${status}</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${message}</ErrorMessage></FlexStatementResponse>`;
const STATEMENT = `<FlexQueryResponse queryName="Screener" type="AF"><FlexStatements count="1"><FlexStatement accountId="U1" fromDate="20261001" toDate="20261014" /></FlexStatements></FlexQueryResponse>`;

interface Call {
  url: URL;
  headers: Headers;
}

function stub(...bodies: Array<string | Error | { status: number; body?: string }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers: new Headers(init?.headers),
    });
    const next = bodies[Math.min(i++, bodies.length - 1)];
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === "object")
      return Promise.resolve(new Response(next.body ?? "", { status: next.status }));
    return Promise.resolve(
      new Response(next ?? "", {
        status: 200,
        headers: { "content-type": "text/plain;charset=UTF-8" },
      }),
    );
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

Deno.test("sendRequest builds the v=3 URL, sends the User-Agent and returns the reference code", async () => {
  const s = stub(SEND_OK);
  const flex = createFlexClient({ userAgent: "TestAgent/1.0", fetchImpl: s.fetchImpl });
  const res = await flex.sendRequest(TOKEN, "123456");
  assertEquals(res, {
    ok: true,
    referenceCode: "1234567890",
    url: "https://example.invalid/never-fetched",
  });
  const call = s.calls[0];
  assert(call !== undefined);
  assertEquals(
    call.url.origin + call.url.pathname,
    "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest",
  );
  assertEquals(call.url.searchParams.get("t"), TOKEN);
  assertEquals(call.url.searchParams.get("q"), "123456");
  assertEquals(call.url.searchParams.get("v"), "3");
  assertEquals(call.url.searchParams.has("p") || call.url.searchParams.has("fd"), false);
  assertEquals(call.headers.get("user-agent"), "TestAgent/1.0");
});

Deno.test("period options: p for days, fd and td for a range, never both, validated", async () => {
  const s = stub(SEND_OK);
  const flex = createFlexClient({ userAgent: "UA", fetchImpl: s.fetchImpl });
  await flex.sendRequest(TOKEN, "1", { days: 365 });
  await flex.sendRequest(TOKEN, "1", { from: "2026-10-01", to: "2026-10-14" });
  assertEquals(s.calls[0]?.url.searchParams.get("p"), "365");
  assertEquals(s.calls[0]?.url.searchParams.has("fd"), false);
  assertEquals(s.calls[1]?.url.searchParams.get("fd"), "20261001");
  assertEquals(s.calls[1]?.url.searchParams.get("td"), "20261014");
  assertEquals(s.calls[1]?.url.searchParams.has("p"), false);
  for (const bad of [
    { days: 0 },
    { days: 366 },
    { days: 1.5 },
    { from: "2026-10-14", to: "2026-10-01" },
    { from: "20261001", to: "bad" },
  ]) {
    const res = await flex.sendRequest(TOKEN, "1", bad as never);
    assertEquals(res.ok, false);
    if (!res.ok) assertEquals(res.code, 1020);
  }
  assertEquals(s.calls.length, 2);
});

Deno.test("sendRequest maps IBKR failures: token invalid, token expired, IP restriction, bad query", async () => {
  for (const [code, text] of [
    [1015, "Token is invalid."],
    [1012, "Token has expired."],
    [1013, "IP restriction."],
    [1014, "Query is invalid."],
  ] as const) {
    const flex = createFlexClient({ userAgent: "UA", fetchImpl: stub(fail(code, text)).fetchImpl });
    assertEquals(await flex.sendRequest(TOKEN, "1"), { ok: false, code, message: text });
  }
});

Deno.test("getStatement returns the XML, builds the URL from the reference code and ignores the response url", async () => {
  const s = stub(STATEMENT);
  const flex = createFlexClient({ userAgent: "UA", fetchImpl: s.fetchImpl });
  const res = await flex.getStatement(TOKEN, "1234567890");
  assertEquals(res.ok, true);
  if (res.ok) assertStringIncludes(res.xml, "<FlexQueryResponse");
  const call = s.calls[0];
  assertEquals(call?.url.pathname.endsWith("/GetStatement"), true);
  assertEquals(call?.url.searchParams.get("q"), "1234567890");
  assertEquals(call?.url.searchParams.get("v"), "3");
  assertEquals(call?.headers.get("user-agent"), "UA");
});

Deno.test("getStatement: 1019 in progress (Warn), 1018 too many requests, 1021 retrieval failure are reported with their codes", async () => {
  for (const [body, code] of [
    [fail(1019, "Statement generation in progress. Please try again shortly.", "Warn"), 1019],
    [fail(1018, "Too many requests have been made from this token.", "Fail"), 1018],
    [fail(1021, "Statement could not be retrieved at this time.", "Fail"), 1021],
    [fail(1012, "Token has expired.", "Fail"), 1012],
    [fail(1013, "IP restriction.", "Fail"), 1013],
  ] as const) {
    const flex = createFlexClient({ userAgent: "UA", fetchImpl: stub(body).fetchImpl });
    const res = await flex.getStatement(TOKEN, "1");
    assertEquals(res.ok, false);
    if (!res.ok) assertEquals(res.code, code);
  }
});

Deno.test("an error code that only appears inside the message is still recovered; garbage is a transport-class failure", async () => {
  const noCode = `<FlexStatementResponse><Status>Fail</Status><ErrorMessage>Error 1019: Statement generation in progress.</ErrorMessage></FlexStatementResponse>`;
  const a = await createFlexClient({
    userAgent: "UA",
    fetchImpl: stub(noCode).fetchImpl,
  }).getStatement(TOKEN, "1");
  assertEquals(a.ok === false && a.code, 1019);
  const b = await createFlexClient({
    userAgent: "UA",
    fetchImpl: stub("<html>maintenance</html>").fetchImpl,
  }).getStatement(TOKEN, "1");
  assertEquals(b.ok === false && b.code, 0);
});

Deno.test("HTTP 429 is 1018, HTTP 5xx and network errors are transport failures, and the token never appears in a message", async () => {
  const limited = await createFlexClient({
    userAgent: "UA",
    fetchImpl: stub({ status: 429 }).fetchImpl,
  }).getStatement(TOKEN, "1");
  assertEquals(limited.ok === false && limited.code, 1018);
  const server = await createFlexClient({
    userAgent: "UA",
    fetchImpl: stub({ status: 503 }).fetchImpl,
  }).sendRequest(TOKEN, "1");
  assertEquals(server.ok === false && server.code, 0);
  const leaky = new Error(`fetch failed: https://ndcdyn.interactivebrokers.com/x?t=${TOKEN}&q=1`);
  const net = await createFlexClient({
    userAgent: "UA",
    fetchImpl: stub(leaky).fetchImpl,
  }).sendRequest(TOKEN, "1");
  assertEquals(net.ok, false);
  assert(!JSON.stringify(net).includes(TOKEN));
  assert(!JSON.stringify(server).includes(TOKEN));
});

Deno.test("the limiter runs before every request; a local limit is reported as 1018 without calling IBKR", async () => {
  const s = stub(SEND_OK);
  const seen: string[] = [];
  const ok = createFlexClient({
    userAgent: "UA",
    fetchImpl: s.fetchImpl,
    limiter: { acquire: (t) => (seen.push(t), Promise.resolve()) },
  });
  await ok.sendRequest(TOKEN, "1");
  assertEquals(seen, [TOKEN]);
  const blocked = createFlexClient({
    userAgent: "UA",
    fetchImpl: s.fetchImpl,
    limiter: { acquire: () => Promise.reject(new FlexLimiterError(45_000)) },
  });
  const res = await blocked.getStatement(TOKEN, "1");
  assertEquals(res.ok === false && res.code, 1018);
  assertEquals(s.calls.length, 1);
});

Deno.test("tokenKey is a stable hash that never contains the token", async () => {
  const a = await tokenKey(TOKEN);
  assertEquals(a, await tokenKey(TOKEN));
  assert(/^flexrl:[0-9a-f]{32}$/.test(a));
  assert(!a.includes(TOKEN));
  assert(a !== (await tokenKey(`${TOKEN}0`)));
});

Deno.test("the RPC limiter waits for the reported time, retries and gives up above the maximum wait", async () => {
  const sleeps: number[] = [];
  const waits = [1100, 0];
  const keys: string[] = [];
  const limiter = createRpcLimiter({
    take: (key) => (keys.push(key), Promise.resolve(waits.shift() ?? 0)),
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
  });
  await limiter.acquire(TOKEN);
  assertEquals(sleeps, [1100]);
  assertEquals(keys.length, 2);
  assert(keys.every((k) => k.startsWith("flexrl:") && !k.includes(TOKEN)));

  const stuck = createRpcLimiter({
    take: () => Promise.resolve(40_000),
    sleep: () => Promise.resolve(),
    maxWaitMs: 15_000,
  });
  let error: unknown;
  try {
    await stuck.acquire(TOKEN);
  } catch (e) {
    error = e;
  }
  assert(error instanceof FlexLimiterError);
  assertEquals((error as FlexLimiterError).waitMs, 40_000);
});

Deno.test("an empty or blank user agent is refused and flexClientFromEnv requires FLEX_USER_AGENT", () => {
  for (const ua of ["", "   "]) {
    let threw = false;
    try {
      createFlexClient({ userAgent: ua, fetchImpl: stub(SEND_OK).fetchImpl });
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(ua));
  }
  const previous = Deno.env.get("FLEX_USER_AGENT");
  try {
    Deno.env.delete("FLEX_USER_AGENT");
    let threw = false;
    try {
      flexClientFromEnv({ fetchImpl: stub(SEND_OK).fetchImpl });
    } catch {
      threw = true;
    }
    assert(threw);
    Deno.env.set("FLEX_USER_AGENT", "FromEnv/1.0");
    flexClientFromEnv({ fetchImpl: stub(SEND_OK).fetchImpl });
  } finally {
    if (previous === undefined) Deno.env.delete("FLEX_USER_AGENT");
    else Deno.env.set("FLEX_USER_AGENT", previous);
  }
});

Deno.test("DTD and entity declarations in an envelope are rejected, never expanded", async () => {
  const evil = `<!DOCTYPE x [<!ENTITY e "boom">]><FlexStatementResponse><Status>Success</Status><ReferenceCode>&e;</ReferenceCode></FlexStatementResponse>`;
  const res = await createFlexClient({
    userAgent: "UA",
    fetchImpl: stub(evil).fetchImpl,
  }).sendRequest(TOKEN, "1");
  assertEquals(res.ok, false);
});

Deno.test("a response above the size cap is aborted with a fatal parse-class code", async () => {
  const big = "x".repeat(2048);
  const flex = createFlexClient({
    userAgent: "UA",
    fetchImpl: stub(big).fetchImpl,
    maxResponseBytes: 1024,
  });
  const res = await flex.getStatement(TOKEN, "1");
  assertEquals(res.ok === false && res.code, -1);
  const streamed = (): Promise<Response> =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(512));
          },
        }),
        { status: 200 },
      ),
    );
  const flex2 = createFlexClient({
    userAgent: "UA",
    fetchImpl: streamed as unknown as typeof fetch,
    maxResponseBytes: 1024,
  });
  const res2 = await flex2.sendRequest(TOKEN, "1");
  assertEquals(res2.ok === false && res2.code, -1);
});
