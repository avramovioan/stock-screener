import { describe, expect, it } from "vitest";
import {
  renderTable,
  replaceBetweenMarkers,
  SUITES,
  selectSuites,
  summarizeOutput,
} from "./verify-all.ts";

describe("summarizeOutput", () => {
  it("reads Vitest, Deno, pgTAP, Playwright and Biome summaries", () => {
    expect(summarizeOutput("test-tools", " Tests  118 passed (118)\n")).toBe("118 tests passed");
    expect(summarizeOutput("functions-test", "ok | 119 passed | 0 failed (12s)\n")).toBe(
      "119 passed, 0 failed",
    );
    expect(
      summarizeOutput("test-db", "Files=11, Tests=642,  9 wallclock secs\nResult: PASS\n"),
    ).toBe("11 files, 642 tests, PASS");
    expect(summarizeOutput("test-e2e", "  14 passed (21.3s)\n")).toBe("14 passed");
    expect(summarizeOutput("lint", "Checked 412 files in 80ms. No fixes applied.\n")).toBe(
      "412 files checked",
    );
    expect(summarizeOutput("build", "nothing recognisable")).toBe("");
  });
  it("reports failures", () => {
    expect(summarizeOutput("test-web", " Tests  2 failed | 90 passed (92)\n")).toBe(
      "2 failed, 90 passed",
    );
  });
});

describe("selectSuites", () => {
  it("filters by --only and --skip and rejects unknown names", () => {
    expect(selectSuites(["lint", "build"], []).map((s) => s.name)).toEqual(["lint", "build"]);
    expect(selectSuites([], ["audit"]).some((s) => s.name === "audit")).toBe(false);
    expect(() => selectSuites(["nope"], [])).toThrow(/unknown suite/);
    expect(SUITES.map((s) => s.name)).toContain("test-e2e-local");
  });
});

describe("renderTable and replaceBetweenMarkers", () => {
  it("renders one row per result with the evidence path", () => {
    const table = renderTable([
      {
        name: "lint",
        command: "bun run lint",
        exitCode: 0,
        durationMs: 4200,
        summary: "412 files checked",
      },
    ]);
    expect(table).toContain(
      "| lint | `bun run lint` | PASS | 412 files checked | 4.2 s | `docs/discovery/p7-evidence/lint.txt` |",
    );
  });
  it("marks a skipped suite and a failure", () => {
    const table = renderTable([
      {
        name: "audit",
        command: "bun run audit",
        exitCode: null,
        durationMs: 0,
        summary: "",
        skipped: "no network",
      },
      { name: "build", command: "bun run build", exitCode: 1, durationMs: 1000, summary: "" },
    ]);
    expect(table).toContain("SKIPPED (no network)");
    expect(table).toContain("FAIL (exit 1)");
  });
  it("replaces only the text between the markers", () => {
    const text = "a\n<!-- suites:begin -->\nold\n<!-- suites:end -->\nb\n";
    expect(replaceBetweenMarkers(text, "suites", "new")).toBe(
      "a\n<!-- suites:begin -->\nnew\n<!-- suites:end -->\nb\n",
    );
    expect(() => replaceBetweenMarkers("no markers", "suites", "x")).toThrow(/markers/);
  });
});
