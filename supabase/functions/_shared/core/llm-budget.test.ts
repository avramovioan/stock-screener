import { describe, expect, it } from "vitest";
import {
  BUDGET_TOTAL_TOKENS,
  CHARS_PER_TOKEN,
  charsLeft,
  estimateTokens,
  MIN_INPUT_TOKENS,
  stepBudget,
} from "./llm-budget.ts";

describe("stepBudget", () => {
  it("gives the primary (no budget) the step's full output and no input limit", () => {
    expect(stepBudget(undefined, 6144)).toEqual({ maxOutputTokens: 6144, inputChars: null });
    expect(stepBudget({ maxInputTokens: null, maxOutputTokens: null }, 4096)).toEqual({
      maxOutputTokens: 4096,
      inputChars: null,
    });
  });

  it("trims the alternate: output capped, input = min(cap, 7500 - output)", () => {
    const b = stepBudget({ maxInputTokens: 4500, maxOutputTokens: 3000 }, 6144);
    expect(b.maxOutputTokens).toBe(3000);
    expect(b.inputChars).toBe(Math.floor(4500 * CHARS_PER_TOKEN));
    expect(estimateTokens(b.inputChars ?? 0) + b.maxOutputTokens).toBeLessThanOrEqual(
      BUDGET_TOTAL_TOKENS,
    );
  });

  it("never sends more output than the step asked for", () => {
    expect(stepBudget({ maxInputTokens: 4500, maxOutputTokens: 3000 }, 1024).maxOutputTokens).toBe(
      1024,
    );
  });

  it("an input cap alone still keeps input + output under 7500", () => {
    const b = stepBudget({ maxInputTokens: 6000, maxOutputTokens: null }, 4096);
    expect(b.maxOutputTokens).toBe(4096);
    expect(b.inputChars).toBe(Math.floor((BUDGET_TOTAL_TOKENS - 4096) * CHARS_PER_TOKEN));
  });

  it("halving halves the input, keeps the output, and has a floor", () => {
    const full = stepBudget({ maxInputTokens: 4500, maxOutputTokens: 3000 }, 6144);
    const half = stepBudget({ maxInputTokens: 4500, maxOutputTokens: 3000 }, 6144, 1);
    expect(half.maxOutputTokens).toBe(3000);
    expect(half.inputChars).toBe(Math.floor(2250 * CHARS_PER_TOKEN));
    expect(half.inputChars).toBeLessThan(full.inputChars ?? 0);
    const tiny = stepBudget({ maxInputTokens: 1000, maxOutputTokens: 3000 }, 6144, 3);
    expect(tiny.inputChars).toBe(Math.floor(MIN_INPUT_TOKENS * CHARS_PER_TOKEN));
  });

  it("an unbudgeted provider that answers 'too large' gets a finite, halved request", () => {
    const b = stepBudget(undefined, 6144, 1);
    expect(b.maxOutputTokens).toBe(6144);
    expect(b.inputChars).toBe(Math.floor(8000 * CHARS_PER_TOKEN));
  });
});

describe("charsLeft", () => {
  it("is unlimited without a budget and never below the floor", () => {
    expect(charsLeft(null, 5000)).toBeNull();
    expect(charsLeft(15_750, 4800)).toBe(10_950);
    expect(charsLeft(3000, 5000)).toBe(1500);
  });
});
