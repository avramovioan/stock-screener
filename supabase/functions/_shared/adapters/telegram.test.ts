import { assert, assertEquals, assertFalse } from "@std/assert";
import { loadTelegramEnv, sendTelegramMessage } from "./telegram.ts";

const ENV = { botToken: "123456:SECRET-token", chatId: "-1001234567890" };

function fakeFetch(respond: () => Response | Error) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const out = respond();
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }) as typeof fetch;
  return { fn, calls };
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.test("loadTelegramEnv: both names set means on, trimmed", () => {
  const env = loadTelegramEnv(
    (n) => ({ TELEGRAM_BOT_TOKEN: " t ", TELEGRAM_CHAT_ID: " -100 " })[n],
  );
  assertEquals(env, { botToken: "t", chatId: "-100" });
});

Deno.test("loadTelegramEnv: either name missing or blank means off, never an error", () => {
  assertEquals(
    loadTelegramEnv(() => undefined),
    null,
  );
  assertEquals(
    loadTelegramEnv((n) => (n === "TELEGRAM_BOT_TOKEN" ? "t" : "  ")),
    null,
  );
  assertEquals(
    loadTelegramEnv((n) => (n === "TELEGRAM_CHAT_ID" ? "-1" : undefined)),
    null,
  );
});

Deno.test("sends sendMessage with HTML parse mode and no link preview, and returns the message id", async () => {
  const f = fakeFetch(() => reply(200, { ok: true, result: { message_id: 77 } }));
  const result = await sendTelegramMessage(ENV, "<b>hi</b>", { fetchImpl: f.fn });
  assertEquals(result, { ok: true, messageId: 77 });
  assertEquals(f.calls[0]?.url, "https://api.telegram.org/bot123456:SECRET-token/sendMessage");
  assertEquals(f.calls[0]?.init?.method, "POST");
  assertEquals(JSON.parse(String(f.calls[0]?.init?.body)), {
    chat_id: "-1001234567890",
    text: "<b>hi</b>",
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
});

Deno.test("429 is rate limited and carries parameters.retry_after", async () => {
  const f = fakeFetch(() =>
    reply(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 17",
      parameters: { retry_after: 17 },
    }),
  );
  assertEquals(await sendTelegramMessage(ENV, "x", { fetchImpl: f.fn }), {
    ok: false,
    kind: "rate_limited",
    status: 429,
    retryAfterSec: 17,
    description: "Too Many Requests: retry after 17",
  });
});

Deno.test("5xx is a server error and worth a retry", async () => {
  const f = fakeFetch(() => reply(502, { ok: false, description: "Bad Gateway" }));
  const r = await sendTelegramMessage(ENV, "x", { fetchImpl: f.fn });
  assertEquals(r.ok === false && r.kind, "server");
  assertEquals(r.ok === false && r.status, 502);
});

Deno.test("a 5xx with a non-JSON body is still a server error", async () => {
  const f = fakeFetch(() => new Response("<html>oops</html>", { status: 503 }));
  const r = await sendTelegramMessage(ENV, "x", { fetchImpl: f.fn });
  assertEquals(r.ok === false && r.kind, "server");
});

Deno.test("a 4xx is rejected for good, with Telegram's own description", async () => {
  const f = fakeFetch(() => reply(400, { ok: false, description: "Bad Request: chat not found" }));
  assertEquals(await sendTelegramMessage(ENV, "x", { fetchImpl: f.fn }), {
    ok: false,
    kind: "rejected",
    status: 400,
    description: "Bad Request: chat not found",
  });
});

Deno.test("a network failure is retryable and never exposes the error text (it can hold the URL)", async () => {
  const f = fakeFetch(
    () => new Error("fetch failed: https://api.telegram.org/bot123456:SECRET-token/sendMessage"),
  );
  const r = await sendTelegramMessage(ENV, "x", { fetchImpl: f.fn });
  assertEquals(r, { ok: false, kind: "network" });
  assertFalse(JSON.stringify(r).includes("SECRET"));
});

Deno.test("the token never appears in a result, even when Telegram echoes it", async () => {
  const f = fakeFetch(() =>
    reply(401, { ok: false, description: "Unauthorized bot123456:SECRET-token" }),
  );
  const r = await sendTelegramMessage(ENV, "x", { fetchImpl: f.fn });
  assert(r.ok === false && r.kind === "rejected");
  assertFalse(JSON.stringify(r).includes("SECRET-token"));
});
