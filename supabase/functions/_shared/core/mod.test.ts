import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "./mod.ts";

describe("core module", () => {
  it("exports the P0 skeleton version", () => {
    expect(CORE_VERSION).toBe("0.0.1");
  });

  it("uses a semantic version string", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
