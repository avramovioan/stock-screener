import { assertEquals } from "jsr:@std/assert@1";
import { classifyHttpFailure, isRequestTooLarge } from "./util.ts";

const kindOf = (status: number, body: string) => classifyHttpFailure(status, body, []).kind;

Deno.test("classifyHttpFailure: transient capacity statuses are unavailable", () => {
  for (const status of [500, 502, 503, 504]) assertEquals(kindOf(status, "{}"), "unavailable");
});

Deno.test("classifyHttpFailure: the Gemini overload body is unavailable", () => {
  const body = JSON.stringify({
    error: {
      code: 503,
      message:
        "This model is currently experiencing high demand. Spikes in demand are usually temporary.",
      status: "UNAVAILABLE",
    },
  });
  assertEquals(kindOf(503, body), "unavailable");
  assertEquals(kindOf(400, body), "unavailable"); // matched by the body, not only the status
});

Deno.test("classifyHttpFailure: overloaded and deadline bodies are unavailable", () => {
  assertEquals(kindOf(529, '{"error":{"message":"Overloaded"}}'), "unavailable");
  assertEquals(kindOf(200, "model is overloaded"), "unavailable");
  assertEquals(kindOf(504, '{"error":{"status":"DEADLINE_EXCEEDED"}}'), "unavailable");
});

Deno.test("classifyHttpFailure: 429 stays quota or rate_limited, even with an overload word", () => {
  assertEquals(kindOf(429, '{"error":{"message":"slow down"}}'), "rate_limited");
  assertEquals(kindOf(429, '{"error":{"message":"overloaded, try later"}}'), "rate_limited");
  assertEquals(
    kindOf(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota PerDay exceeded"}}'),
    "quota",
  );
});

Deno.test("classifyHttpFailure: other client errors stay http", () => {
  assertEquals(kindOf(400, '{"error":{"message":"bad request"}}'), "http");
  assertEquals(kindOf(401, "{}"), "http");
});

Deno.test("classifyHttpFailure: reads the Mistral top-level message", () => {
  const res = classifyHttpFailure(
    429,
    JSON.stringify({
      object: "error",
      message: "Rate limit exceeded",
      type: "rate_limited",
      code: "1300",
    }),
    [],
  );
  assertEquals(res.kind, "rate_limited");
  assertEquals(res.message, "Rate limit exceeded");
  const down = classifyHttpFailure(
    503,
    JSON.stringify({
      object: "error",
      message: "Service unavailable.",
      type: "service_unavailable",
    }),
    [],
  );
  assertEquals(down.kind, "unavailable");
  assertEquals(down.message, "Service unavailable.");
});

Deno.test("isRequestTooLarge: 413, 'request too large' and a requested size above the whole limit; not a merely busy minute", () => {
  assertEquals(isRequestTooLarge(413, ""), true);
  assertEquals(isRequestTooLarge(400, "Request too large for model x"), true);
  assertEquals(isRequestTooLarge(429, "TPM: Limit 8000, Used 0, Requested 12934."), true);
  assertEquals(
    isRequestTooLarge(429, "TPM: Limit 8000, Used 6100, Requested 3400. Try again in 3s"),
    false,
  );
  assertEquals(isRequestTooLarge(429, "slow down"), false);
  assertEquals(isRequestTooLarge(500, "boom"), false);
});

Deno.test("classifyHttpFailure: a Groq per-minute token 429 is rate_limited, not a daily quota", () => {
  const body =
    '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 900. Please try again in 22.5s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}';
  assertEquals(kindOf(429, body), "rate_limited");
});

Deno.test("classifyHttpFailure: a Groq per-day token 429 is a daily quota", () => {
  const body =
    '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199500, Requested 900. Please try again in 1h2m3s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}';
  assertEquals(kindOf(429, body), "quota");
});

Deno.test("classifyHttpFailure: a Groq per-day request 429 is a daily quota", () => {
  const body =
    '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1.","type":"requests","code":"rate_limit_exceeded"}}';
  assertEquals(kindOf(429, body), "quota");
});

Deno.test("classifyHttpFailure: a Gemini per-minute 429 is rate_limited, not a daily quota", () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan and billing details.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
              quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            },
          ],
        },
      ],
    },
  });
  assertEquals(kindOf(429, body), "rate_limited");
});

Deno.test("classifyHttpFailure: a Gemini per-day 429 is a daily quota", () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan and billing details.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
              quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            },
          ],
        },
      ],
    },
  });
  assertEquals(kindOf(429, body), "quota");
});

Deno.test("classifyHttpFailure: an OpenAI insufficient_quota 429 is a daily quota", () => {
  assertEquals(
    kindOf(
      429,
      '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
    ),
    "quota",
  );
});
