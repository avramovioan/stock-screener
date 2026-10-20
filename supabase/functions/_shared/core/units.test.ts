import { describe, expect, it } from "vitest";
import { resolveCurrency, toMajor } from "./units.ts";

describe("resolveCurrency", () => {
  it.each([
    ["GBp", "GBP", 100],
    ["ZAc", "ZAR", 100],
    ["ILA", "ILS", 100],
    ["KWF", "KWD", 1000],
  ])("maps minor unit %s to %s / %i", (code, major, divisor) => {
    expect(resolveCurrency(code)).toEqual({ major, divisor });
  });

  it("passes major currencies through with divisor 1", () => {
    expect(resolveCurrency("GBP")).toEqual({ major: "GBP", divisor: 1 });
    expect(resolveCurrency("USD")).toEqual({ major: "USD", divisor: 1 });
  });

  it("passes an unknown code through unchanged", () => {
    expect(resolveCurrency("XYZ")).toEqual({ major: "XYZ", divisor: 1 });
  });

  it("is case sensitive: GBP and GBp differ", () => {
    expect(resolveCurrency("GBP").divisor).toBe(1);
    expect(resolveCurrency("GBp").divisor).toBe(100);
  });

  it("does not resolve Object.prototype keys as currencies", () => {
    expect(resolveCurrency("constructor")).toEqual({ major: "constructor", divisor: 1 });
    expect(resolveCurrency("__proto__")).toEqual({ major: "__proto__", divisor: 1 });
  });

  it("returns a fresh object that callers cannot use to mutate the table", () => {
    const first = resolveCurrency("GBp");
    first.divisor = 1;
    expect(resolveCurrency("GBp").divisor).toBe(100);
  });
});

describe("toMajor", () => {
  it("divides a GBp price into GBP", () => {
    expect(toMajor(3950, "GBp")).toBe(39.5);
  });
  it("divides KWF by 1000", () => {
    expect(toMajor(2500, "KWF")).toBe(2.5);
  });
  it("leaves a major-unit price alone", () => {
    expect(toMajor(123.45, "EUR")).toBe(123.45);
  });
  it("leaves an unknown code alone", () => {
    expect(toMajor(10, "XYZ")).toBe(10);
  });
});
