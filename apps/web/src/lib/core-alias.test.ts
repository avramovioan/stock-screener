import { CORE_VERSION } from "@core/mod.ts";
import { describe, expect, it } from "vitest";

describe("@core alias", () => {
  it("resolves the shared core module outside apps/web", () => {
    expect(CORE_VERSION).toBe("0.0.1");
  });
});
