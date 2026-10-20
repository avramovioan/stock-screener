import { describe, expect, it } from "vitest";
import { type FetchPolicy, fetchPolicyProblems, findFetchCalls } from "./fetch-callsites.ts";

describe("findFetchCalls", () => {
  it("finds fetch and fetchImpl calls and ignores comments and type uses", () => {
    const text = [
      "// fetch(x)",
      " * fetch(y)",
      "const r = await fetch(url);",
      "const q = o.fetchImpl(u, i);",
      "type F = typeof fetch;",
      "const t = throttle.fetch(u);",
    ].join("\n");
    expect(findFetchCalls("a.ts", text).map((c) => c.line)).toEqual([3, 4, 6]);
  });
});

describe("fetchPolicyProblems", () => {
  const policy: Record<string, FetchPolicy> = {
    "f/guarded.ts": {
      category: "ssrf-guarded",
      reason: "search results",
      requires: ["publicUrlProblem"],
    },
    "f/fixed.ts": { category: "fixed-host", reason: "api.example.com" },
    "f/gone.ts": { category: "fixed-host", reason: "removed" },
  };
  it("accepts reviewed files whose guard is present and lists stale entries separately", () => {
    const result = fetchPolicyProblems(
      [
        { file: "f/guarded.ts", text: "import { publicUrlProblem } from 'x'; fetch(u)" },
        { file: "f/fixed.ts", text: "fetch('https://api.example.com')" },
      ],
      policy,
    );
    expect(result.problems).toEqual([]);
    expect(result.stale).toEqual(["f/gone.ts"]);
  });
  it("flags an unreviewed call site and a guarded file that lost its guard", () => {
    const result = fetchPolicyProblems(
      [
        { file: "f/new.ts", text: "const r = await fetch(userUrl);" },
        { file: "f/guarded.ts", text: "fetch(u)" },
      ],
      policy,
    );
    expect(result.problems.join("\n")).toMatch(/f\/new\.ts:1.*not reviewed/);
    expect(result.problems.join("\n")).toMatch(/f\/guarded\.ts.*publicUrlProblem/);
  });
  it("ignores files without a call", () => {
    expect(fetchPolicyProblems([{ file: "f/none.ts", text: "const a = 1;" }], {}).problems).toEqual(
      [],
    );
  });
});
