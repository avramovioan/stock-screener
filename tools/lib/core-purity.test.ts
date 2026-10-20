import { describe, expect, it } from "vitest";
import { findPurityViolations } from "./core-purity.ts";

const rules = (source: string) => findPurityViolations(source).map((v) => v.rule);

describe("findPurityViolations", () => {
  it("accepts a pure module", () => {
    const source = [
      'import { a } from "./a.ts";',
      'import type { B } from "../b.ts";',
      "export const x = (nowMs: number) => new Date(nowMs).getTime();",
      'export const f = new Intl.DateTimeFormat("en", { timeZone: "Europe/Sofia" });',
    ].join("\n");
    expect(rules(source)).toEqual([]);
  });

  it("flags Date.now()", () => {
    expect(rules("export const t = Date.now();")).toEqual(["no-date-now"]);
  });

  it("flags new Date() without arguments but not with arguments", () => {
    expect(rules("export const t = new Date();")).toEqual(["no-new-date-without-args"]);
    expect(rules("export const t = new Date( );")).toEqual(["no-new-date-without-args"]);
    expect(rules("export const t = new Date(0);")).toEqual([]);
  });

  it("flags Math.random()", () => {
    expect(rules("export const r = Math.random();")).toEqual(["no-math-random"]);
  });

  it("flags bare and alias imports", () => {
    expect(rules('import { z } from "zod";')).toEqual(["no-bare-or-alias-import"]);
    expect(rules('import { x } from "@core/mod.ts";')).toEqual(["no-bare-or-alias-import"]);
    expect(rules('export { y } from "node:fs";')).toEqual(["no-bare-or-alias-import"]);
    expect(rules('const m = await import("npm:left-pad");')).toEqual(["no-bare-or-alias-import"]);
  });

  it("flags relative imports without the .ts extension", () => {
    expect(rules('import { a } from "./a";')).toEqual(["relative-import-needs-ts-extension"]);
    expect(rules('import { a } from "../a.js";')).toEqual(["relative-import-needs-ts-extension"]);
  });

  it("ignores forbidden text inside comments", () => {
    const source = ["// Date.now() is forbidden here", "/* Math.random() */", " * new Date()"].join(
      "\n",
    );
    expect(rules(source)).toEqual([]);
  });

  it("reports 1-based line numbers", () => {
    const violations = findPurityViolations("export const a = 1;\nexport const t = Date.now();");
    expect(violations[0]?.line).toBe(2);
  });
});
