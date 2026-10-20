import { assertEquals } from "@std/assert";
import { MAX_SYMBOLS, normalizeQuery, normalizeSymbol, parseSymbols } from "./validate.ts";

Deno.test("normalizeSymbol upper-cases and accepts Yahoo symbols", () => {
  assertEquals(normalizeSymbol("msft"), "MSFT");
  assertEquals(normalizeSymbol("0700.HK"), "0700.HK");
  assertEquals(normalizeSymbol("BRK-B"), "BRK-B");
  assertEquals(normalizeSymbol("^GSPC"), "^GSPC");
  assertEquals(normalizeSymbol("EURUSD=X"), "EURUSD=X");
});

Deno.test("normalizeSymbol rejects junk", () => {
  for (const bad of [
    "",
    " ",
    "a b",
    "<script>",
    "../etc",
    "A".repeat(21),
    ".X",
    "A;B",
    5,
    null,
    undefined,
  ]) {
    assertEquals(normalizeSymbol(bad), null, String(bad));
  }
});

Deno.test("normalizeQuery enforces 2-40 characters and no control characters", () => {
  assertEquals(normalizeQuery("  micro  soft "), "micro soft");
  assertEquals(normalizeQuery("a"), null);
  assertEquals(normalizeQuery("ab"), "ab");
  assertEquals(normalizeQuery("x".repeat(40)), "x".repeat(40));
  assertEquals(normalizeQuery("x".repeat(41)), null);
  assertEquals(normalizeQuery("a\u0007b"), null);
  assertEquals(normalizeQuery("<b>"), null);
  assertEquals(normalizeQuery(null), null);
});

Deno.test("parseSymbols validates, upper-cases and de-duplicates", () => {
  assertEquals(parseSymbols({ symbols: ["msft", "MSFT", "aapl"] }), {
    ok: true,
    symbols: ["MSFT", "AAPL"],
  });
});

Deno.test("parseSymbols rejects bad bodies", () => {
  assertEquals(parseSymbols(null).ok, false);
  assertEquals(parseSymbols({}).ok, false);
  assertEquals(parseSymbols({ symbols: [] }).ok, false);
  assertEquals(parseSymbols({ symbols: "MSFT" }).ok, false);
  assertEquals(parseSymbols({ symbols: ["MSFT", "bad symbol"] }).ok, false);
  assertEquals(parseSymbols({ symbols: [1] }).ok, false);
});

Deno.test("parseSymbols allows exactly 50 and rejects 51", () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);
  assertEquals(MAX_SYMBOLS, 50);
  assertEquals(parseSymbols({ symbols: make(50) }).ok, true);
  assertEquals(parseSymbols({ symbols: make(51) }).ok, false);
});
