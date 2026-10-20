import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createLlmChain, createLlmProviders, parseTokenLimit } from "./index.ts";

const GEMINI = { GEMINI_API_KEY: "g-key-1234", GEMINI_MODEL: "gm" };
const ALT = {
  LLM_ALT_BASE_URL: "https://alt.example/v1",
  LLM_ALT_API_KEY: "a-key-1234",
  LLM_ALT_MODEL: "am",
  LLM_ALT_PROVIDER: "groq",
};

Deno.test("factory: gemini is the default primary, the alt is the alternate", () => {
  const p = createLlmProviders({ ...GEMINI, ...ALT });
  assertEquals(p.primary.name, "gemini");
  assertEquals(p.alternate.name, "groq");
  assertEquals(p.order, ["gemini", "groq"]);
  assertEquals(Object.keys(p.byName).sort(), ["gemini", "groq"]);
});

Deno.test("factory: LLM_PRIMARY=openai_compatible swaps the roles", () => {
  const p = createLlmProviders({ LLM_PRIMARY: "openai_compatible", ...GEMINI, ...ALT });
  assertEquals(p.primary.name, "groq");
  assertEquals(p.alternate.name, "gemini");
});

Deno.test("factory: missing keys give not_configured stubs, never an exception", async () => {
  const p = createLlmProviders({});
  assertEquals(p.primary.configured, false);
  assertEquals(p.alternate.configured, false);
  const res = await p.primary.generateJson({
    system: "s",
    user: "u",
    maxOutputTokens: 1,
    temperature: 0,
    schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  });
  assertEquals(res.ok, false);
  if (!res.ok) assertEquals(res.kind, "not_configured");
});

Deno.test("LLM_PRIMARY: an unknown value is a configuration error; known values and blank are accepted", () => {
  assertThrows(() => createLlmProviders({ LLM_PRIMARY: "gemni" }), Error, "LLM_PRIMARY");
  for (const value of [undefined, "", " gemini ", "openai_compatible"]) {
    createLlmProviders({ LLM_PRIMARY: value });
  }
});

Deno.test("LLM_ALT_BASE_URL: a non-https URL leaves the alternate unconfigured (D-41 follow-up, already fail-soft)", () => {
  const p = createLlmProviders({ ...ALT, LLM_ALT_BASE_URL: "http://api.example.com/v1" });
  assertEquals(p.alternate.configured, false);
});

Deno.test("LLM_ALT_MAX_INPUT_TOKENS / LLM_ALT_MAX_OUTPUT_TOKENS: the alternate carries a budget, the primary never does", () => {
  const p = createLlmProviders({
    ...GEMINI,
    ...ALT,
    LLM_ALT_MAX_INPUT_TOKENS: "4500",
    LLM_ALT_MAX_OUTPUT_TOKENS: " 3000 ",
  });
  assertEquals(p.alternate.budget, { maxInputTokens: 4500, maxOutputTokens: 3000 });
  assertEquals(p.primary.budget, undefined);
  // swapped: the budget stays with the provider it was configured for
  const s = createLlmProviders({
    LLM_PRIMARY: "openai_compatible",
    ...GEMINI,
    ...ALT,
    LLM_ALT_MAX_INPUT_TOKENS: "4500",
  });
  assertEquals(s.primary.budget, { maxInputTokens: 4500, maxOutputTokens: null });
  assertEquals(s.alternate.budget, undefined);
  // unset = unlimited
  assertEquals(createLlmProviders({ ...GEMINI, ...ALT }).alternate.budget, undefined);
});

Deno.test("parseTokenLimit: positive whole numbers only; anything else is unlimited", () => {
  assertEquals(parseTokenLimit("4500"), 4500);
  assertEquals(parseTokenLimit(undefined), null);
  assertEquals(parseTokenLimit(""), null);
  assertEquals(parseTokenLimit("0"), null);
  assertEquals(parseTokenLimit("-5"), null);
  assertEquals(parseTokenLimit("4.5k"), null);
});

const CHAIN = [
  {
    key: "gemini:gemini-3.5-flash",
    provider: "gemini",
    label: "gemini",
    model: "gemini-3.5-flash",
    base_url: null,
    max_input_tokens: null,
    max_output_tokens: null,
    reasoning_effort: null,
    quota_reset: "pacific",
  },
  {
    key: "gemini:gemini-3.5-flash-lite",
    provider: "gemini",
    label: "gemini",
    model: "gemini-3.5-flash-lite",
    base_url: null,
    max_input_tokens: null,
    max_output_tokens: null,
    reasoning_effort: null,
    quota_reset: "pacific",
  },
  {
    key: "groq:openai/gpt-oss-120b",
    provider: "openai_compatible",
    label: "groq",
    model: "openai/gpt-oss-120b",
    base_url: "https://api.groq.com/openai/v1",
    max_input_tokens: 4500,
    max_output_tokens: 3000,
    reasoning_effort: "low",
    quota_reset: "utc",
  },
];

Deno.test("chain: one provider per entry, named by the entry key, in order", () => {
  const c = createLlmChain(CHAIN, { ...GEMINI, ...ALT });
  assertEquals(
    c.order,
    CHAIN.map((e) => e.key),
  );
  assertEquals(Object.keys(c.byName), c.order);
  assertEquals(c.byName["gemini:gemini-3.5-flash-lite"]?.model, "gemini-3.5-flash-lite");
  assertEquals(c.byName["gemini:gemini-3.5-flash-lite"]?.name, "gemini:gemini-3.5-flash-lite");
  assertEquals(c.byName["groq:openai/gpt-oss-120b"]?.model, "openai/gpt-oss-120b");
});

Deno.test("chain: the budget, quota reset and keys follow the entry; both gemini models use GEMINI_API_KEY", () => {
  const c = createLlmChain(CHAIN, { ...GEMINI, ...ALT });
  const groq = c.byName["groq:openai/gpt-oss-120b"];
  assertEquals(groq?.budget, { maxInputTokens: 4500, maxOutputTokens: 3000 });
  assertEquals(groq?.quotaReset, "utc");
  assertEquals(groq?.configured, true);
  assertEquals(c.byName["gemini:gemini-3.5-flash"]?.quotaReset, "pacific");
  assertEquals(c.byName["gemini:gemini-3.5-flash"]?.budget, undefined);
  assertEquals(c.byName["gemini:gemini-3.5-flash"]?.configured, true);
});

Deno.test("chain: a missing key leaves that provider unconfigured, never an exception", () => {
  const c = createLlmChain(CHAIN, { GEMINI_API_KEY: "g-key-1234" });
  assertEquals(
    c.order.map((k) => c.byName[k]?.configured),
    [true, true, false],
  );
});

Deno.test("chain: an absent or invalid setting falls back to the env pair", () => {
  for (const bad of [
    undefined,
    null,
    "x",
    [],
    [{ key: "a" }],
    [CHAIN[0], CHAIN[0]],
    [{ ...CHAIN[2], base_url: "http://insecure.example/v1" }],
    [{ ...CHAIN[0], quota_reset: "mars" }],
  ]) {
    const c = createLlmChain(bad, { ...GEMINI, ...ALT });
    assertEquals(c.order, ["gemini", "groq"], JSON.stringify(bad));
  }
});
