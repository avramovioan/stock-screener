export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The only JSON-Schema shape the pipeline sends: an object with every property required. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface GenerateJsonRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  schemaName?: string | undefined;
  maxOutputTokens: number;
  temperature: number;
  signal?: AbortSignal | undefined;
}

export type LlmFailureKind =
  | "rate_limited"
  | "quota"
  /** Transient provider capacity error (HTTP 500/502/503/504, "UNAVAILABLE", "overloaded", "high demand"). */
  | "unavailable"
  | "invalid_json"
  | "schema"
  | "http"
  | "network"
  | "not_configured";

export type GenerateJsonResult<T> =
  | { ok: true; json: T; usage: { input: number; output: number }; model: string }
  | {
      ok: false;
      kind: LlmFailureKind;
      status?: number | undefined;
      message: string;
      /** The request itself exceeds the provider's size limit (kind is "schema"): the caller may resend a smaller one. */
      tooLarge?: true | undefined;
    };

/** Optional per-provider request budget (LLM_ALT_MAX_INPUT_TOKENS / LLM_ALT_MAX_OUTPUT_TOKENS); null = unlimited. */
export interface LlmBudget {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

/** When a model's per-day free quota starts over: Gemini at midnight Pacific, Groq at midnight UTC. */
export type QuotaReset = "pacific" | "utc";

export interface LlmProvider {
  readonly name: string;
  /** Set for chain models (`app_settings.research.llm_chain`); the worker derives `exhausted_until` from it on a per-day quota answer. */
  readonly quotaReset?: QuotaReset | undefined;
  readonly model: string;
  /** Set for a provider with a small per-request or per-minute token limit (Groq free tier); absent = unlimited. */
  readonly budget?: LlmBudget | undefined;
  /** False for a stub whose key or model is missing; `plan` uses it to avoid spending a call. */
  readonly configured: boolean;
  generateJson<T>(req: GenerateJsonRequest): Promise<GenerateJsonResult<T>>;
}
