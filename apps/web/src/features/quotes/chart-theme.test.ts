import { describe, expect, it } from "vitest";
import { LINE_KEYS } from "./chart-data";
import { chartPalette, lineStyleFor } from "./chart-theme";

const HEX = /^#[0-9a-f]{6}$/i;

describe("chartPalette", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`${theme}: every colour is a hex string the chart library can parse`, () => {
      for (const v of Object.values(chartPalette(theme))) expect(v).toMatch(HEX);
      for (const key of LINE_KEYS) expect(lineStyleFor(key, theme).color).toMatch(HEX);
    });
  }
  it("light and dark differ", () => {
    expect(chartPalette("light").background).not.toBe(chartPalette("dark").background);
  });
});

describe("lineStyleFor", () => {
  it("set 2 uses a different dash pattern than set 1 (identification never depends on colour)", () => {
    expect(lineStyleFor("upper1", "light").dash).toBe("dashed");
    expect(lineStyleFor("base", "light").dash).toBe("dashed");
    expect(lineStyleFor("lower1", "light").dash).toBe("dashed");
    expect(lineStyleFor("upper2", "light").dash).toBe("large");
    expect(lineStyleFor("lower2", "light").dash).toBe("large");
  });
  it("follows the script colours: base and lower-1 orange, upper-1 blue, set 2 green", () => {
    expect(lineStyleFor("base", "light").color).toBe(lineStyleFor("lower1", "light").color);
    expect(lineStyleFor("upper2", "dark").color).toBe(lineStyleFor("lower2", "dark").color);
    expect(lineStyleFor("upper1", "light").color).not.toBe(lineStyleFor("base", "light").color);
  });
});
