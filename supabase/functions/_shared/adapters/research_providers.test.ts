import { assertEquals, assertThrows } from "@std/assert";
import type { Db } from "./db.ts";
import { createResearchDeps } from "./research_providers.ts";

const db = { sb: {} } as unknown as Db;

Deno.test("PROVIDER_MODE=fixture is refused outside the local stack", () => {
  const base = { PROVIDER_MODE: "fixture", ALLOW_FIXTURE_PROVIDERS: "1" };
  assertThrows(
    () => createResearchDeps({ ...base, SUPABASE_URL: "https://abc.supabase.co" }, db),
    Error,
    "refused",
  );
  assertThrows(
    () =>
      createResearchDeps({ PROVIDER_MODE: "fixture", SUPABASE_URL: "http://127.0.0.1:54321" }, db),
    Error,
    "refused",
  );
  createResearchDeps({ ...base, SUPABASE_URL: "http://127.0.0.1:54321" }, db);
  createResearchDeps({ ...base, SUPABASE_URL: "http://kong:8000" }, db);
});

Deno.test("the owner's llm_chain replaces the env pair once the research settings are loaded", async () => {
  const chain = [
    {
      key: "gemini:m1",
      provider: "gemini",
      label: "gemini",
      model: "m1",
      base_url: null,
      max_input_tokens: null,
      max_output_tokens: null,
      reasoning_effort: null,
      quota_reset: "pacific",
    },
    {
      key: "gemini:m2",
      provider: "gemini",
      label: "gemini",
      model: "m2",
      base_url: null,
      max_input_tokens: null,
      max_output_tokens: null,
      reasoning_effort: null,
      quota_reset: "pacific",
    },
  ];
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: { value: { llm_chain: chain } } }),
  };
  const sb = { from: () => query };
  const deps = createResearchDeps({ GEMINI_API_KEY: "g-key-1234", GEMINI_MODEL: "env-model" }, {
    sb,
  } as unknown as Db);
  assertEquals(deps.llmOrder[0], "gemini", "the env pair until the settings are loaded");
  const settings = await deps.settings();
  assertEquals(settings.busy_retry_minutes, 15);
  assertEquals(deps.llmOrder, ["gemini:m1", "gemini:m2"]);
  assertEquals(Object.keys(deps.llm), ["gemini:m1", "gemini:m2"]);
  assertEquals(deps.llm["gemini:m2"]?.model, "m2");
});
