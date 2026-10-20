import { requireHttpsBase } from "../env.ts";
import { logError } from "../log.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createOpenAiCompatibleProvider } from "./openai-compatible.ts";
import type { FetchLike, LlmProvider, QuotaReset } from "./types.ts";

export type {
  FetchLike,
  GenerateJsonRequest,
  GenerateJsonResult,
  JsonSchema,
  LlmBudget,
  LlmFailureKind,
  LlmProvider,
  QuotaReset,
} from "./types.ts";

export interface LlmEnv {
  LLM_PRIMARY?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
  GEMINI_MODEL?: string | undefined;
  LLM_ALT_PROVIDER?: string | undefined;
  LLM_ALT_BASE_URL?: string | undefined;
  LLM_ALT_API_KEY?: string | undefined;
  LLM_ALT_MODEL?: string | undefined;
  /** Optional request budget of the alternate provider (Groq free tier: 8,000 tokens per minute). Unset = unlimited. */
  LLM_ALT_MAX_INPUT_TOKENS?: string | undefined;
  LLM_ALT_MAX_OUTPUT_TOKENS?: string | undefined;
  /** low | medium | high; sent as `reasoning_effort`. Unset: "low" for an `openai/gpt-oss*` model, else nothing. */
  LLM_ALT_REASONING_EFFORT?: string | undefined;
}

/** A positive whole number from an env string; unset, blank or invalid means "no limit" (null). */
export function parseTokenLimit(value: string | undefined): number | null {
  const v = value?.trim() ?? "";
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

export interface LlmProviders {
  primary: LlmProvider;
  alternate: LlmProvider;
  /** Keyed by `provider.name`; a report stores the name and later steps look the provider up here. */
  byName: Record<string, LlmProvider>;
  /** Primary first, then alternate. */
  order: string[];
}

/** An invalid LLM_ALT_BASE_URL (not https outside a local stack) leaves the alternate provider unconfigured instead of failing every tick. */
function safeBase(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return value;
  try {
    return requireHttpsBase("LLM_ALT_BASE_URL", value.trim());
  } catch (e) {
    logError("llm alternate provider disabled", e);
    return undefined;
  }
}

/** Missing keys never throw: the provider is a `configured = false` stub that answers `not_configured`. */
export function createLlmProviders(env: LlmEnv, fetchImpl?: FetchLike): LlmProviders {
  const primaryName = (env.LLM_PRIMARY ?? "").trim();
  if (primaryName !== "" && primaryName !== "gemini" && primaryName !== "openai_compatible") {
    throw new Error(`LLM_PRIMARY must be "gemini" or "openai_compatible" (found "${primaryName}")`);
  }
  const gemini = createGeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    fetchImpl,
  });
  const alt = createOpenAiCompatibleProvider({
    label: env.LLM_ALT_PROVIDER,
    baseUrl: safeBase(env.LLM_ALT_BASE_URL),
    apiKey: env.LLM_ALT_API_KEY,
    model: env.LLM_ALT_MODEL,
    reasoningEffort: env.LLM_ALT_REASONING_EFFORT,
    budget: {
      maxInputTokens: parseTokenLimit(env.LLM_ALT_MAX_INPUT_TOKENS),
      maxOutputTokens: parseTokenLimit(env.LLM_ALT_MAX_OUTPUT_TOKENS),
    },
    fetchImpl,
  });
  const swapped = primaryName === "openai_compatible";
  const primary = swapped ? alt : gemini;
  const alternate = swapped ? gemini : alt;
  return {
    primary,
    alternate,
    byName: { [primary.name]: primary, [alternate.name]: alternate },
    order: [primary.name, alternate.name],
  };
}

/** One model of `app_settings.research.llm_chain` (see the shared contract). API keys stay in the function secrets. */
export interface LlmChainEntry {
  key: string;
  provider: "gemini" | "openai_compatible";
  label: string;
  model: string;
  base_url: string | null;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  reasoning_effort: "low" | "medium" | "high" | null;
  quota_reset: QuotaReset;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const limit = (v: unknown): number | null | undefined =>
  v === null || v === undefined
    ? null
    : Number.isInteger(v) && (v as number) > 0
      ? (v as number)
      : undefined;

/** The validated chain, or null (absent, empty, or any entry invalid): the caller then uses the env-defined pair. */
export function parseLlmChain(value: unknown): LlmChainEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: LlmChainEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const key = text(raw.key);
    const model = text(raw.model);
    const label = text(raw.label);
    const provider = raw.provider;
    const reset = raw.quota_reset;
    const effort = raw.reasoning_effort ?? null;
    const maxIn = limit(raw.max_input_tokens);
    const maxOut = limit(raw.max_output_tokens);
    if (key === "" || model === "" || label === "" || seen.has(key)) return null;
    if (provider !== "gemini" && provider !== "openai_compatible") return null;
    if (reset !== "pacific" && reset !== "utc") return null;
    if (effort !== null && effort !== "low" && effort !== "medium" && effort !== "high")
      return null;
    if (maxIn === undefined || maxOut === undefined) return null;
    let baseUrl: string | null = null;
    if (provider === "openai_compatible") {
      try {
        baseUrl = requireHttpsBase("llm_chain base_url", text(raw.base_url));
      } catch {
        return null;
      }
    }
    seen.add(key);
    out.push({
      key,
      provider,
      label,
      model,
      base_url: baseUrl,
      max_input_tokens: maxIn,
      max_output_tokens: maxOut,
      reasoning_effort: effort,
      quota_reset: reset,
    });
  }
  return out;
}

export interface LlmChain {
  /** Keyed by `provider.name` (= the entry key); a report stores the name and later steps look the provider up here. */
  byName: Record<string, LlmProvider>;
  /** Chain order, first model first. */
  order: string[];
}

/**
 * One provider per chain entry. An absent or invalid setting gives today's pair: the Gemini env model (Pacific reset) then the
 * LLM_ALT_* model (UTC reset). Missing keys never throw: that model is a `configured = false` stub the walk skips.
 */
export function createLlmChain(
  chainSetting: unknown,
  env: LlmEnv,
  fetchImpl?: FetchLike,
): LlmChain {
  const entries = parseLlmChain(chainSetting);
  if (entries === null) {
    const pair = createLlmProviders(env, fetchImpl);
    const gemini = pair.byName["gemini"];
    const withReset = (p: LlmProvider, quotaReset: QuotaReset): LlmProvider => ({
      ...p,
      quotaReset,
    });
    const byName: Record<string, LlmProvider> = {};
    for (const name of pair.order) {
      const p = pair.byName[name];
      if (p) byName[name] = withReset(p, p === gemini ? "pacific" : "utc");
    }
    return { byName, order: pair.order };
  }
  const byName: Record<string, LlmProvider> = {};
  for (const e of entries) {
    const base =
      e.provider === "gemini"
        ? createGeminiProvider({
            name: e.key,
            apiKey: env.GEMINI_API_KEY,
            model: e.model,
            fetchImpl,
          })
        : createOpenAiCompatibleProvider({
            label: e.key,
            baseUrl: e.base_url ?? undefined,
            apiKey: env.LLM_ALT_API_KEY,
            model: e.model,
            reasoningEffort: e.reasoning_effort ?? undefined,
            budget: { maxInputTokens: e.max_input_tokens, maxOutputTokens: e.max_output_tokens },
            fetchImpl,
          });
    byName[e.key] = { ...base, quotaReset: e.quota_reset };
  }
  return { byName, order: entries.map((e) => e.key) };
}
