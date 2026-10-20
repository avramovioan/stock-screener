import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { createGeminiProvider, toGeminiSchema } from "./gemini.ts";
import { fakeFetch, jsonResponse } from "./testing.ts";
import type { GenerateJsonRequest, JsonSchema } from "./types.ts";

const SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim"],
        properties: { claim: { type: "string" }, title: { type: "string" } },
      },
    },
  },
};

const REQ: GenerateJsonRequest = {
  system: "SYSTEM TEXT",
  user: "USER TEXT",
  schema: SCHEMA,
  maxOutputTokens: 512,
  temperature: 0.1,
};

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: '{"facts":[]}' }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 7 },
};

function provider(fetchImpl: ReturnType<typeof fakeFetch>["fetchImpl"], key = "KEY-123456") {
  return createGeminiProvider({ apiKey: key, model: "gemini-test-model", fetchImpl });
}

Deno.test("gemini: builds the generateContent request and parses usage", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const res = await provider(fetchImpl).generateJson<{ facts: unknown[] }>(REQ);
  assert(res.ok);
  assertEquals(res.json, { facts: [] });
  assertEquals(res.usage, { input: 120, output: 7 });
  assertEquals(res.model, "gemini-test-model");
  const call = calls[0];
  assert(call);
  assertEquals(
    call.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent",
  );
  assertEquals(call.method, "POST");
  assertEquals(call.headers["x-goog-api-key"], "KEY-123456");
  // biome-ignore lint/suspicious/noExplicitAny: test fixture access
  const body = call.body as Record<string, any>;
  assertEquals(body.systemInstruction.parts[0].text, "SYSTEM TEXT");
  assertEquals(body.contents[0].parts[0].text, "USER TEXT");
  assertEquals(body.generationConfig.responseMimeType, "application/json");
  assertEquals(body.generationConfig.temperature, 0.1);
  assertEquals(body.generationConfig.maxOutputTokens, 512);
  assertFalse(
    JSON.stringify(body.generationConfig.responseSchema).includes("additionalProperties"),
  );
  assertFalse(JSON.stringify(body).includes("googleSearch"), "no grounding tools, ever");
});

Deno.test("gemini: toGeminiSchema strips unsupported keywords but keeps property names", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test fixture access
  const out = toGeminiSchema(SCHEMA) as Record<string, any>;
  assertFalse("additionalProperties" in out);
  assert("title" in out.properties.facts.items.properties, "a property called title survives");
  assertEquals(out.required, ["facts"]);
});

Deno.test("gemini: 429 RESOURCE_EXHAUSTED per day maps to quota, per minute to rate_limited", async () => {
  const day = fakeFetch(() =>
    jsonResponse(
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "quota",
          details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }],
        },
      },
      429,
    ),
  );
  const a = await provider(day.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "quota");
  assertEquals(a.status, 429);
  const minute = fakeFetch(() =>
    jsonResponse(
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "slow down",
          details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }],
        },
      },
      429,
    ),
  );
  const b = await provider(minute.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "rate_limited");
});

Deno.test("gemini: unparseable text is invalid_json, a truncated reply too", async () => {
  const bad = fakeFetch(() =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "not json" }] }, finishReason: "STOP" }],
    }),
  );
  const a = await provider(bad.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "invalid_json");
  const cut = fakeFetch(() =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: '{"facts":[' }] }, finishReason: "MAX_TOKENS" }],
    }),
  );
  const b = await provider(cut.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "invalid_json");
  assert(b.message.includes("truncated"));
});

Deno.test("gemini: a fenced JSON reply is accepted", async () => {
  const f = fakeFetch(() =>
    jsonResponse({
      candidates: [
        { content: { parts: [{ text: '```json\n{"facts":[]}\n```' }] }, finishReason: "STOP" },
      ],
    }),
  );
  const res = await provider(f.fetchImpl).generateJson(REQ);
  assert(res.ok);
});

Deno.test("gemini: blocked prompt or no candidates is a schema failure; a JSON array is too", async () => {
  const blocked = fakeFetch(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
  const a = await provider(blocked.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "schema");
  const arr = fakeFetch(() =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "[1,2]" }] }, finishReason: "STOP" }],
    }),
  );
  const b = await provider(arr.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "schema");
});

Deno.test("gemini: a missing key or model is not_configured and never calls fetch", async () => {
  const f = fakeFetch(() => jsonResponse(OK_BODY));
  const noKey = createGeminiProvider({ apiKey: "", model: "m", fetchImpl: f.fetchImpl });
  assertEquals(noKey.configured, false);
  const a = await noKey.generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "not_configured");
  const noModel = createGeminiProvider({ apiKey: "KEY-123456", fetchImpl: f.fetchImpl });
  const b = await noModel.generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "not_configured");
  assertEquals(f.calls.length, 0);
});

Deno.test("gemini: network errors never echo the key; 503 is unavailable", async () => {
  const net = fakeFetch(() => {
    throw new Error("connect failed for https://x?key=KEY-123456");
  });
  const a = await provider(net.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "network");
  assertFalse(a.message.includes("KEY-123456"));
  const five = fakeFetch(() => jsonResponse({ error: { message: "boom" } }, 503));
  const b = await provider(five.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "unavailable");
  assertEquals(b.status, 503);
});
