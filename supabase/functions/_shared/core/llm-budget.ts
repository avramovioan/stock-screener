// supabase/functions/_shared/core/llm-budget.ts
// Pure request sizing for a provider with a small per-request or per-minute token limit (Groq free tier: 8,000 TPM).
// No Date, URL, console, fetch or randomness (core purity guard).

/**
 * Conservative characters-per-token estimate. English prose averages about 4 characters per token and filings with numbers,
 * tickers and punctuation about 3 to 3.5; JSON schemas are denser still. 3.5 over-counts tokens on prose, which is the safe side
 * for a hard limit: a request that is estimated at 7,000 tokens is in practice at or below it.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Input estimate plus max output must stay under this for a provider that has a budget: the 8,000 tokens per minute of the
 * Groq free tier minus about 6% of headroom for the estimate's error and the chat-template tokens.
 */
export const BUDGET_TOTAL_TOKENS = 7500;

/** Never size a request below this many input tokens, however small the budget (the prompt itself needs room). */
export const MIN_INPUT_TOKENS = 1200;

/** Input size assumed for a provider with no input budget when a request is halved after a "too large" answer (about 48,000 chars). */
export const UNBUDGETED_INPUT_TOKENS = 16_000;

export interface TokenBudget {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

export interface StepBudget {
  /** The max_tokens to send (never above the step's own default). */
  maxOutputTokens: number;
  /** Characters the WHOLE request text (system + schema + user) may use; null = unlimited. */
  inputChars: number | null;
}

export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * The size of one LLM request. `budget` undefined (or both limits null) is the full, unlimited request: the step's own
 * `defaultOutputTokens` and no input limit. Otherwise the output is lowered to the alternate's cap and the input gets what is left:
 * min(maxInputTokens, 7,500 - output), halved once per `halvings` (a "request too large" answer), never under 1,200 tokens.
 */
export function stepBudget(
  budget: TokenBudget | null | undefined,
  defaultOutputTokens: number,
  halvings = 0,
): StepBudget {
  const limited =
    budget !== null &&
    budget !== undefined &&
    (budget.maxInputTokens !== null || budget.maxOutputTokens !== null);
  if (!limited && halvings === 0) return { maxOutputTokens: defaultOutputTokens, inputChars: null };
  const output = Math.min(defaultOutputTokens, budget?.maxOutputTokens ?? defaultOutputTokens);
  const room = limited
    ? Math.min(budget.maxInputTokens ?? Number.POSITIVE_INFINITY, BUDGET_TOTAL_TOKENS - output)
    : UNBUDGETED_INPUT_TOKENS;
  const input = Math.max(MIN_INPUT_TOKENS, Math.floor(room / 2 ** halvings));
  return { maxOutputTokens: output, inputChars: Math.floor(input * CHARS_PER_TOKEN) };
}

/** Characters left for the variable part (evidence, document text) after the fixed request text; never below `floor`. */
export function charsLeft(
  inputChars: number | null,
  fixedChars: number,
  floor = 1500,
): number | null {
  return inputChars === null ? null : Math.max(floor, inputChars - fixedChars);
}
