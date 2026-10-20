import type { FetchLike, GenerateJsonRequest, GenerateJsonResult, LlmProvider } from "./types.ts";
import { classifyHttpFailure, errorMessage, isPlainObject, parseModelJson } from "./util.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini `responseSchema` is an OpenAPI subset. `additionalProperties`, `$schema`, `title` and `default`
 * are removed at the keyword level; names inside a `properties` map are never filtered.
 * The accepted subset is verified in P2-01; this is the only place to change if it differs.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!isPlainObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "$schema" || key === "title" || key === "default")
      continue;
    if (key === "properties" && isPlainObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, toGeminiSchema(sub)]),
      );
    } else {
      out[key] = toGeminiSchema(value);
    }
  }
  return out;
}

export interface GeminiOptions {
  /** Provider id stored on a report; default "gemini". A chain gives each model its own (`gemini:<model>`). */
  name?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function createGeminiProvider(opts: GeminiOptions): LlmProvider {
  const apiKey = opts.apiKey?.trim() ?? "";
  const model = opts.model?.trim() ?? "";
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const configured = apiKey !== "" && model !== "";

  return {
    name: opts.name?.trim() || "gemini",
    model,
    configured,
    async generateJson<T>(req: GenerateJsonRequest): Promise<GenerateJsonResult<T>> {
      if (!configured) {
        return {
          ok: false,
          kind: "not_configured",
          message: apiKey === "" ? "GEMINI_API_KEY is not set" : "GEMINI_MODEL is not set",
        };
      }
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(req.schema),
          temperature: req.temperature,
          maxOutputTokens: req.maxOutputTokens,
        },
      };
      let res: Response;
      try {
        res = await doFetch(`${BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
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
        return { ok: false, kind: failure.kind, status: failure.status, message: failure.message };
      }
      let payload: GeminiResponse;
      try {
        payload = JSON.parse(text) as GeminiResponse;
      } catch {
        return { ok: false, kind: "invalid_json", message: "response body is not JSON" };
      }
      const candidate = payload.candidates?.[0];
      if (!candidate) {
        const reason = payload.promptFeedback?.blockReason;
        return {
          ok: false,
          kind: "schema",
          message: reason ? `prompt blocked: ${reason}` : "no candidates in the response",
        };
      }
      if (candidate.finishReason === "MAX_TOKENS") {
        return { ok: false, kind: "invalid_json", message: "output truncated at maxOutputTokens" };
      }
      const output = (candidate.content?.parts ?? []).map((p) => p.text ?? "").join("");
      const parsed = parseModelJson(output);
      if (!parsed.ok) return { ok: false, kind: "invalid_json", message: parsed.message };
      if (!isPlainObject(parsed.json)) {
        return { ok: false, kind: "schema", message: "model output is not a JSON object" };
      }
      return {
        ok: true,
        json: parsed.json as T,
        usage: {
          input: payload.usageMetadata?.promptTokenCount ?? 0,
          output: payload.usageMetadata?.candidatesTokenCount ?? 0,
        },
        model,
      };
    },
  };
}
