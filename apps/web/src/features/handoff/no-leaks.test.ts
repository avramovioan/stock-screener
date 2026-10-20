import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing typed or generated in the hand-off (side, quantity, price, symbol, prompt) may be logged, stored in the browser or sent anywhere
 * except the two reads and the one own-row write in handoff-api.ts and the existing quotes call. A static guard, because a stray
 * console.log of the prompt would pass every behavioural test.
 */
const dir = import.meta.dirname;
const sources = readdirSync(dir)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));

describe("hand-off source files", () => {
  it("found the feature files", () => {
    expect(sources.map((s) => s.file)).toContain("trade-on-ibkr-dialog.tsx");
    expect(sources.map((s) => s.file)).toContain("derive.ts");
  });

  it("never log, persist or beacon anything", () => {
    for (const { file, text } of sources) {
      for (const forbidden of [
        /\bconsole\./,
        /\blocalStorage\b/,
        /\bsessionStorage\b/,
        /\bindexedDB\b/,
        /\bsendBeacon\b/,
        /\bdocument\.cookie\b/,
      ]) {
        expect(text, `${file} must not use ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("only handoff-api.ts (and default.ts, which creates the client) talk to the backend", () => {
    for (const { file, text } of sources) {
      if (file === "handoff-api.ts" || file === "default.ts") continue;
      expect(text, `${file} must not call fetch or the supabase client directly`).not.toMatch(
        /\bfetch\(|\.from\(|supabase\b/,
      );
    }
  });

  it("builds prompts from the IBKR local symbol only: derive.ts never reads the Yahoo symbol (review focus 2)", () => {
    const derive = sources.find((s) => s.file === "derive.ts");
    expect(derive?.text).toBeDefined();
    expect(derive?.text).not.toMatch(/eurSymbolYahoo|yahoo_symbol|yahooSymbol/);
  });

  it("never builds an order-submission control", () => {
    for (const { file, text } of sources) {
      expect(text.toLowerCase(), `${file} must not mention submitting an order`).not.toMatch(
        /submit order|place order|placeorder|submitorder/,
      );
    }
  });
});
