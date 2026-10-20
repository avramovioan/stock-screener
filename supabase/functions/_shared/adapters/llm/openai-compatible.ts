import type {
  FetchLike,
  GenerateJsonRequest,
  GenerateJsonResult,
  LlmBudget,
  LlmProvider,
} from "./types.ts";
import {
  classifyHttpFailure,
  errorMessage,
  isPlainObject,
  isRequestTooLarge,
  parseModelJson,
} from "./util.ts";

export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Request-shape hook: the `reasoning_effort` field Groq documents for its reasoning models
 * (openai/gpt-oss-20b and -120b accept "low" | "medium" | "high", default "medium"; any other value is a 400).
 * An explicit LLM_ALT_REASONING_EFFORT wins; otherwise "low" for a model id that starts with `openai/gpt-oss`
 * (reasoning tokens share the completion budget and the per-minute token limit, so the cheapest effort is used);
 * otherwise nothing is sent.
 */
export function reasoningEffortFor(
  model: string,
  override?: string | undefined,
): ReasoningEffort | undefined {
  const o = override?.trim().toLowerCase();
  if (o === "low" || o === "medium" || o === "high") return o;
  return model.trim().toLowerCase().startsWith("openai/gpt-oss") ? "low" : undefined;
}

export interface OpenAiCompatibleOptions {
  label?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  /** LLM_ALT_REASONING_EFFORT: low | medium | high; anything else is ignored. */
  reasoningEffort?: string | undefined;
  /** LLM_ALT_MAX_INPUT_TOKENS / LLM_ALT_MAX_OUTPUT_TOKENS, exposed on the provider so each step can size its request. */
  budget?: LlmBudget | undefined;
}

interface ChatResponse {
  choices?: {
    message?: { content?: string | { type?: string; text?: string }[] | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Any chat-completions endpoint with `response_format: json_schema` (Groq, OpenRouter, Mistral, Gemini-compat). */
export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  const baseUrl = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
  const apiKey = opts.apiKey?.trim() ?? "";
  const model = opts.model?.trim() ?? "";
  const label = opts.label?.trim() ?? "";
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const configured = baseUrl !== "" && apiKey !== "" && model !== "";
  // The label (LLM_ALT_PROVIDER, e.g. "mistral") is the provider id stored on a report; "gemini" would collide with the primary
  const name =
    label === "" ? "openai_compatible" : label === "gemini" ? "openai_compatible:gemini" : label;

  const effort = reasoningEffortFor(model, opts.reasoningEffort);
  const budget =
    opts.budget && (opts.budget.maxInputTokens !== null || opts.budget.maxOutputTokens !== null)
      ? opts.budget
      : undefined;

  return {
    name,
    model,
    configured,
    budget,
    async generateJson<T>(req: GenerateJsonRequest): Promise<GenerateJsonResult<T>> {
      if (!configured) {
        return {
          ok: false,
          kind: "not_configured",
          message: "LLM_ALT_BASE_URL, LLM_ALT_API_KEY or LLM_ALT_MODEL is not set",
        };
      }
      const body = {
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature: req.temperature,
        max_tokens: req.maxOutputTokens,
        ...(effort ? { reasoning_effort: effort } : {}),
        response_format: {
          type: "json_schema",
          json_schema: { name: req.schemaName ?? "output", schema: req.schema, strict: true },
        },
      };
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (e) {
        return { ok: false, kind: "network", message: errorMessage(e, [apiKey]) };
      }
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        return { ok: false, kind: "network", message: errorMessage(e, [apiKey]) };
      }
      if (!res.ok) {
        const failure = classifyHttpFailure(res.status, text, [apiKey]);
        // The request itself is too big (HTTP 413, or a TPM error whose requested size exceeds the whole limit): resending it
        // unchanged can never work. It is a size failure, not a generic http one, so the caller can retry once with less input.
        if (isRequestTooLarge(res.status, text)) {
          return {
            ok: false,
            kind: "schema",
            status: failure.status,
            message: failure.message,
            tooLarge: true,
          };
        }
        // A backend that rejects the structured-output request (422, or a 400 naming the schema) is an unusable answer for this
        // call, like invalid output: it must not throw as a generic http failure and burn job attempts.
        const schemaRejected =
          failure.kind === "http" &&
          (res.status === 422 ||
            (res.status === 400 && /schema|response_format|structured/i.test(text)));
        return {
          ok: false,
          kind: schemaRejected ? "schema" : failure.kind,
          status: failure.status,
          message: failure.message,
        };
      }
      let payload: ChatResponse;
      try {
        payload = JSON.parse(text) as ChatResponse;
      } catch {
        return { ok: false, kind: "invalid_json", message: "response body is not JSON" };
      }
      const choice = payload.choices?.[0];
      if (!choice) return { ok: false, kind: "schema", message: "no choices in the response" };
      if (choice.finish_reason === "length" || choice.finish_reason === "model_length") {
        return { ok: false, kind: "invalid_json", message: "output truncated at max_tokens" };
      }
      const raw = choice.message?.content;
      // Mistral may answer with an array of typed chunks instead of a string
      const content = Array.isArray(raw) ? raw.map((c) => c.text ?? "").join("") : (raw ?? "");
      const parsed = parseModelJson(content);
      if (!parsed.ok) return { ok: false, kind: "invalid_json", message: parsed.message };
      if (!isPlainObject(parsed.json)) {
        return { ok: false, kind: "schema", message: "model output is not a JSON object" };
      }
      return {
        ok: true,
        json: parsed.json as T,
        usage: {
          input: payload.usage?.prompt_tokens ?? 0,
          output: payload.usage?.completion_tokens ?? 0,
        },
        model,
      };
    },
  };
}
