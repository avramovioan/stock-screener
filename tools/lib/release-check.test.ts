import { describe, expect, it } from "vitest";
import {
  evidenceProblems,
  gitProblems,
  trackedForbiddenFiles,
  unresolvedMarkers,
} from "./release-check.ts";

describe("trackedForbiddenFiles", () => {
  it("flags env files other than examples, local state and build output", () => {
    const files = [
      ".env",
      "apps/web/.env.local",
      "apps/web/.env.example",
      "supabase/functions/.env",
      "supabase/functions/.env.e2e",
      "supabase/.temp/x",
      "apps/web/dist/a.js",
      "backups/a.sql",
      "src/a.ts",
    ];
    expect(trackedForbiddenFiles(files)).toEqual([
      ".env",
      "apps/web/.env.local",
      "supabase/functions/.env",
      "supabase/functions/.env.e2e",
      "supabase/.temp/x",
      "apps/web/dist/a.js",
      "backups/a.sql",
    ]);
  });
});

describe("unresolvedMarkers", () => {
  it("finds TODO, TBD, FIXME and unfilled angle markers with line numbers", () => {
    expect(unresolvedMarkers("ok\nTODO: later\nfine\nvalue <fill in>\n")).toEqual([
      "line 2: TODO: later",
      "line 4: value <fill in>",
    ]);
    expect(unresolvedMarkers("all good")).toEqual([]);
  });
});

describe("evidenceProblems", () => {
  const ok = {
    results: [
      { name: "lint", exitCode: 0 },
      { name: "build", exitCode: 0 },
    ],
  };
  it("requires every suite present, passing and not skipped", () => {
    expect(evidenceProblems(ok, ["lint", "build"])).toEqual([]);
    expect(evidenceProblems(ok, ["lint", "test-db"])).toEqual(["suite test-db has no evidence"]);
    expect(evidenceProblems({ results: [{ name: "lint", exitCode: 1 }] }, ["lint"])).toEqual([
      "suite lint did not pass (exit 1)",
    ]);
    expect(
      evidenceProblems({ results: [{ name: "lint", exitCode: null, skipped: "x" }] }, ["lint"]),
    ).toEqual(["suite lint was skipped (x)"]);
  });
});

describe("gitProblems", () => {
  const base = { branch: "build/initial", porcelain: "", behind: 0, ahead: 12, tagExists: false };
  it("accepts a clean branch that can fast-forward", () => {
    expect(gitProblems(base)).toEqual([]);
  });
  it("flags every violation", () => {
    expect(gitProblems({ ...base, branch: "master" }).join("\n")).toMatch(/build\/initial/);
    expect(gitProblems({ ...base, porcelain: " M a.ts" }).join("\n")).toMatch(/clean/);
    expect(gitProblems({ ...base, behind: 2 }).join("\n")).toMatch(/fast-forward/);
    expect(gitProblems({ ...base, ahead: 0 }).join("\n")).toMatch(/nothing to merge/);
    expect(gitProblems({ ...base, tagExists: true }).join("\n")).toMatch(/v0\.1\.0-local/);
  });
});
