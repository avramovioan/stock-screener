import { assert, assertEquals } from "jsr:@std/assert@1";
import { createOpenAiCompatibleProvider, reasoningEffortFor } from "./openai-compatible.ts";
import { fakeFetch, jsonResponse } from "./testing.ts";
import type { GenerateJsonRequest } from "./types.ts";

const REQ: GenerateJsonRequest = {
  system: "S",
  user: "U",
  schemaName: "change_check",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["material"],
    properties: { material: { type: "boolean" } },
  },
  maxOutputTokens: 256,
  temperature: 0,
};

const OK = {
  choices: [{ message: { content: '{"material":false}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 4 },
};

function make(fetchImpl: ReturnType<typeof fakeFetch>["fetchImpl"]) {
  return createOpenAiCompatibleProvider({
    label: "groq",
    baseUrl: "https://api.groq.com/openai/v1/",
    apiKey: "ALT-KEY-1234",
    model: "alt-model",
    fetchImpl,
  });
}

Deno.test("openai-compatible: posts chat/completions with a strict json_schema response_format", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK));
  const p = make(fetchImpl);
  assertEquals(p.name, "groq");
  const res = await p.generateJson<{ material: boolean }>(REQ);
  assert(res.ok);
  assertEquals(res.json, { material: false });
  assertEquals(res.usage, { input: 50, output: 4 });
  const call = calls[0];
  assert(call);
  assertEquals(call.url, "https://api.groq.com/openai/v1/chat/completions");
  assertEquals(call.headers.authorization, "Bearer ALT-KEY-1234");
  // biome-ignore lint/suspicious/noExplicitAny: test fixture access
  const body = call.body as Record<string, any>;
  assertEquals(body.model, "alt-model");
  assertEquals(body.messages, [
    { role: "system", content: "S" },
    { role: "user", content: "U" },
  ]);
  assertEquals(body.response_format.type, "json_schema");
  assertEquals(body.response_format.json_schema.name, "change_check");
  assertEquals(body.response_format.json_schema.strict, true);
  assertEquals(body.max_tokens, 256);
});

Deno.test("openai-compatible: maps failures", async () => {
  const quota = fakeFetch(() =>
    jsonResponse({ error: { code: "insufficient_quota", message: "no credit" } }, 429),
  );
  const a = await make(quota.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "quota");
  const rate = fakeFetch(() => jsonResponse({ error: { message: "slow" } }, 429));
  const b = await make(rate.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "rate_limited");
  const bad = fakeFetch(() =>
    jsonResponse({ choices: [{ message: { content: "nope" }, finish_reason: "stop" }] }),
  );
  const c = await make(bad.fetchImpl).generateJson(REQ);
  assert(!c.ok);
  assertEquals(c.kind, "invalid_json");
  const cut = fakeFetch(() =>
    jsonResponse({ choices: [{ message: { content: '{"mat' }, finish_reason: "length" }] }),
  );
  const d = await make(cut.fetchImpl).generateJson(REQ);
  assert(!d.ok);
  assertEquals(d.kind, "invalid_json");
});

Deno.test("openai-compatible: missing configuration is not_configured", async () => {
  const f = fakeFetch(() => jsonResponse(OK));
  const p = createOpenAiCompatibleProvider({
    baseUrl: "",
    apiKey: "",
    model: "",
    fetchImpl: f.fetchImpl,
  });
  assertEquals(p.configured, false);
  const res = await p.generateJson(REQ);
  assert(!res.ok);
  assertEquals(res.kind, "not_configured");
  assertEquals(f.calls.length, 0);
});

// Mistral La Plateforme (https://api.mistral.ai/v1): fixtures follow its OpenAPI spec (ChatCompletionResponse, JsonSchema, error body)
const fixture = (name: string): unknown =>
  JSON.parse(Deno.readTextFileSync(new URL(`../fixtures/mistral/${name}`, import.meta.url)));

function mistral(fetchImpl: ReturnType<typeof fakeFetch>["fetchImpl"]) {
  return createOpenAiCompatibleProvider({
    label: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: "MISTRAL-KEY-9876",
    model: "mistral-large-latest",
    fetchImpl,
  });
}

Deno.test("openai-compatible: Mistral request shape and response", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(fixture("chat-ok.json")));
  const p = mistral(fetchImpl);
  assertEquals(p.name, "mistral"); // the label is the provider id stored on a report
  const res = await p.generateJson<{ material: boolean }>(REQ);
  assert(res.ok);
  assertEquals(res.json, { material: true });
  assertEquals(res.usage, { input: 412, output: 37 });
  assertEquals(res.model, "mistral-large-latest");
  const call = calls[0];
  assert(call);
  assertEquals(call.url, "https://api.mistral.ai/v1/chat/completions");
  assertEquals(call.headers.authorization, "Bearer MISTRAL-KEY-9876");
  // biome-ignore lint/suspicious/noExplicitAny: test fixture access
  const body = call.body as Record<string, any>;
  // Mistral JsonSchema wire fields are name, schema, strict (schema_definition is only the SDK alias)
  assertEquals(Object.keys(body.response_format).sort(), ["json_schema", "type"]);
  assertEquals(body.response_format.type, "json_schema");
  assertEquals(Object.keys(body.response_format.json_schema).sort(), ["name", "schema", "strict"]);
  assertEquals(body.response_format.json_schema.schema, REQ.schema);
  assertEquals(body.max_tokens, 256);
});

Deno.test("openai-compatible: Mistral content may be an array of text chunks", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(fixture("chat-chunks.json")));
  const res = await mistral(fetchImpl).generateJson<{ material: boolean }>(REQ);
  assert(res.ok);
  assertEquals(res.json, { material: false });
});

Deno.test("openai-compatible: Mistral finish_reason model_length is a truncation", async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse({ choices: [{ message: { content: '{"mat' }, finish_reason: "model_length" }] }),
  );
  const res = await mistral(fetchImpl).generateJson(REQ);
  assert(!res.ok);
  assertEquals(res.kind, "invalid_json");
});

Deno.test("openai-compatible: Mistral errors map to rate_limited and unavailable", async () => {
  const limited = fakeFetch(() => jsonResponse(fixture("rate-limited-429.json"), 429));
  const a = await mistral(limited.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals([a.kind, a.status, a.message], ["rate_limited", 429, "Rate limit exceeded"]);
  const down = fakeFetch(() => jsonResponse(fixture("service-unavailable-503.json"), 503));
  const b = await mistral(down.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals([b.kind, b.status], ["unavailable", 503]);
});

Deno.test("openai-compatible: a schema rejection (422, or 400 naming the schema) is kind schema, other 400s stay http", async () => {
  const reject = (status: number, message: string) =>
    mistral(
      fakeFetch(() =>
        jsonResponse({ object: "error", message, type: "invalid_request_error" }, status),
      ).fetchImpl,
    ).generateJson(REQ);
  const a = await reject(422, "Unprocessable entity");
  assert(!a.ok);
  assertEquals([a.kind, a.status], ["schema", 422]);
  const b = await reject(
    400,
    "Invalid response_format: json_schema is not supported for this strict schema",
  );
  assert(!b.ok);
  assertEquals(b.kind, "schema");
  const c = await reject(400, "Invalid model");
  assert(!c.ok);
  assertEquals(c.kind, "http");
  const d = await reject(401, "Unauthorized");
  assert(!d.ok);
  assertEquals(d.kind, "http");
});

// Mistral's strict json_schema accepts the plain subset: type, properties, required, additionalProperties:false, items, enum.
// Every schema the pipeline sends must stay inside it, so strict:true is safe for the backup.
Deno.test("pipeline schemas stay inside the strict json_schema subset Mistral documents", async () => {
  const { RESEARCH_OUTPUT_SCHEMA, STAGE1_OUTPUT_SCHEMA } = await import("../../core/research.ts");
  const { CHANGE_CLASSIFICATION_SCHEMA } = await import("../../core/risk.ts");
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "description",
  ]);
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => {
        walk(n, `${path}[${i}]`);
      });
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object") {
      const props = Object.keys((obj.properties as object) ?? {});
      assertEquals(obj.additionalProperties, false, `${path}: additionalProperties false`);
      assertEquals(
        [...(obj.required as string[])].sort(),
        props.sort(),
        `${path}: every property required`,
      );
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === "properties") {
        for (const [name, sub] of Object.entries(value as object)) walk(sub, `${path}.${name}`);
      } else {
        assert(allowed.has(key), `${path}: keyword ${key} is outside the strict subset`);
        if (key === "items") walk(value, `${path}[]`);
      }
    }
  };
  for (const [name, schema] of Object.entries({
    RESEARCH_OUTPUT_SCHEMA,
    STAGE1_OUTPUT_SCHEMA,
    CHANGE_CLASSIFICATION_SCHEMA,
  }))
    walk(schema, name);
});

// Groq (https://api.groq.com/openai/v1): openai/gpt-oss-120b is a reasoning model; `reasoning_effort` is low | medium | high
function groq(
  fetchImpl: ReturnType<typeof fakeFetch>["fetchImpl"],
  extra: { model?: string; reasoningEffort?: string } = {},
) {
  return createOpenAiCompatibleProvider({
    label: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "GROQ-KEY-4321",
    model: extra.model ?? "openai/gpt-oss-120b",
    reasoningEffort: extra.reasoningEffort,
    fetchImpl,
  });
}

Deno.test("reasoningEffortFor: low for openai/gpt-oss*, the env value wins, nothing for other models", () => {
  assertEquals(reasoningEffortFor("openai/gpt-oss-120b"), "low");
  assertEquals(reasoningEffortFor("openai/gpt-oss-20b"), "low");
  assertEquals(reasoningEffortFor("OpenAI/GPT-OSS-120B"), "low");
  assertEquals(reasoningEffortFor("openai/gpt-oss-120b", "high"), "high");
  assertEquals(reasoningEffortFor("openai/gpt-oss-120b", " Medium "), "medium");
  assertEquals(
    reasoningEffortFor("openai/gpt-oss-120b", "extreme"),
    "low",
    "an invalid value is ignored",
  );
  assertEquals(reasoningEffortFor("llama-3.3-70b-versatile"), undefined);
  assertEquals(reasoningEffortFor("mistral-large-latest"), undefined);
  assertEquals(
    reasoningEffortFor("llama-3.3-70b-versatile", "high"),
    "high",
    "the env override applies to any model",
  );
});

Deno.test("openai-compatible: Groq gpt-oss request carries reasoning_effort low; other models carry none", async () => {
  const a = fakeFetch(() => jsonResponse(OK));
  const res = await groq(a.fetchImpl).generateJson(REQ);
  assert(res.ok);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture access
  const body = a.calls[0]?.body as Record<string, any>;
  assertEquals(body.reasoning_effort, "low");
  assertEquals(body.model, "openai/gpt-oss-120b");
  assertEquals(body.response_format.json_schema.strict, true);

  const b = fakeFetch(() => jsonResponse(OK));
  await groq(b.fetchImpl, { model: "llama-3.3-70b-versatile" }).generateJson(REQ);
  assertEquals("reasoning_effort" in ((b.calls[0]?.body as object) ?? {}), false);

  const c = fakeFetch(() => jsonResponse(OK));
  await groq(c.fetchImpl, { reasoningEffort: "medium" }).generateJson(REQ);
  const cBody = (c.calls[0]?.body ?? {}) as { reasoning_effort?: string };
  assertEquals(cBody.reasoning_effort, "medium");
});

Deno.test("openai-compatible: Groq 413 request too large is a size failure (schema, tooLarge), never generic http", async () => {
  const f = fakeFetch(() =>
    jsonResponse(
      {
        error: {
          message:
            "Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12934, please reduce your message size and try again.",
          type: "tokens",
          code: "rate_limit_exceeded",
        },
      },
      413,
    ),
  );
  const res = await groq(f.fetchImpl).generateJson(REQ);
  assert(!res.ok);
  assertEquals(res.kind, "schema");
  assertEquals(res.status, 413);
  assertEquals(res.tooLarge, true);
  assert(res.message.includes("Request too large"));
  assert(!res.message.includes("GROQ-KEY-4321"));
});

Deno.test("openai-compatible: a TPM error whose requested size exceeds the limit is a size failure even as a 429", async () => {
  const f = fakeFetch(() =>
    jsonResponse(
      {
        error: {
          message:
            "Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 0, Requested 12934. Please try again in 1m37s.",
          code: "rate_limit_exceeded",
        },
      },
      429,
    ),
  );
  const res = await groq(f.fetchImpl).generateJson(REQ);
  assert(!res.ok);
  assertEquals(res.kind, "schema");
  assertEquals(res.tooLarge, true);
});

Deno.test("openai-compatible: a TPM 429 that fits the limit is rate_limited (the minute is used up), not too large", async () => {
  const f = fakeFetch(() =>
    jsonResponse(
      {
        error: {
          message:
            "Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 6100, Requested 3400. Please try again in 3.75s.",
          type: "tokens",
          code: "rate_limit_exceeded",
        },
      },
      429,
    ),
  );
  const res = await groq(f.fetchImpl).generateJson(REQ);
  assert(!res.ok);
  assertEquals(res.kind, "rate_limited");
  assertEquals(res.status, 429);
  assertEquals(res.tooLarge, undefined);
  // the daily token limit is a quota, not a retry-in-90-seconds
  const d = fakeFetch(() =>
    jsonResponse(
      {
        error: {
          message:
            "Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 199000, Requested 3400.",
          code: "rate_limit_exceeded",
        },
      },
      429,
    ),
  );
  const q = await groq(d.fetchImpl).generateJson(REQ);
  assert(!q.ok);
  assertEquals(q.kind, "quota");
});

Deno.test("openai-compatible: the provider exposes its budget only when a limit is set", () => {
  const none = createOpenAiCompatibleProvider({
    label: "groq",
    baseUrl: "https://x.test/v1",
    apiKey: "k-12345",
    model: "m",
    budget: { maxInputTokens: null, maxOutputTokens: null },
  });
  assertEquals(none.budget, undefined);
  const some = createOpenAiCompatibleProvider({
    label: "groq",
    baseUrl: "https://x.test/v1",
    apiKey: "k-12345",
    model: "m",
    budget: { maxInputTokens: 4500, maxOutputTokens: null },
  });
  assertEquals(some.budget, { maxInputTokens: 4500, maxOutputTokens: null });
});
