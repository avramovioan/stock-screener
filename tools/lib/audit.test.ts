import { describe, expect, it } from "vitest";
import { auditProblems, parseBunAudit, parseNpmAudit, specifiersFromSource } from "./audit.ts";

const bun = {
  "left-pad": [
    {
      id: 1111,
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      title: "bad",
      severity: "high",
      vulnerable_versions: "<1.3.1",
    },
  ],
  fine: [
    {
      id: 2222,
      url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
      title: "meh",
      severity: "low",
    },
  ],
};
const npm = {
  vulnerabilities: {
    "fast-xml-parser": {
      severity: "critical",
      via: [
        {
          source: 3333,
          name: "fast-xml-parser",
          title: "entity expansion",
          url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii",
          severity: "critical",
        },
        "other-pkg",
      ],
    },
  },
};

describe("parsers", () => {
  it("reads the Bun format", () => {
    expect(parseBunAudit(bun).map((a) => [a.pkg, a.severity, a.id])).toEqual([
      ["left-pad", "high", "GHSA-aaaa-bbbb-cccc"],
      ["fine", "low", "GHSA-dddd-eeee-ffff"],
    ]);
  });
  it("reads the npm format and ignores transitive string entries", () => {
    expect(parseNpmAudit(npm).map((a) => [a.pkg, a.severity, a.id])).toEqual([
      ["fast-xml-parser", "critical", "GHSA-gggg-hhhh-iiii"],
    ]);
  });
  it("returns nothing for an empty or unknown shape", () => {
    expect(parseBunAudit({})).toEqual([]);
    expect(parseNpmAudit({ vulnerabilities: {} })).toEqual([]);
    expect(parseNpmAudit(null)).toEqual([]);
  });
});

describe("auditProblems", () => {
  const advisories = [...parseBunAudit(bun), ...parseNpmAudit(npm)];
  const now = Date.parse("2026-10-15T00:00:00Z");
  it("blocks high and critical advisories without an exception", () => {
    const { problems } = auditProblems(advisories, [], now);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/GHSA-aaaa-bbbb-cccc/);
  });
  it("accepts a documented exception until it expires and flags an expired one", () => {
    const exceptions = [
      { id: "GHSA-aaaa-bbbb-cccc", reason: "dev-only path, not reachable", expires: "2027-01-01" },
      { id: "GHSA-gggg-hhhh-iiii", reason: "no fix yet", expires: "2026-01-01" },
    ];
    const { problems } = auditProblems(advisories, exceptions, now);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/expired/);
  });
  it("warns about an exception that matches nothing", () => {
    const { warnings } = auditProblems(
      [],
      [{ id: "GHSA-zzzz-zzzz-zzzz", reason: "x", expires: "2027-01-01" }],
      now,
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("specifiersFromSource", () => {
  it("finds npm: specifiers with scope and exact version", () => {
    const text = `import a from "npm:fast-xml-parser@5.11.2"; import { x } from 'npm:@supabase/supabase-js@2.117.3'; "npm:yahoo-finance2@4.0.3"; "npm:nover"`;
    expect(specifiersFromSource(text)).toEqual([
      { name: "fast-xml-parser", version: "5.11.2" },
      { name: "@supabase/supabase-js", version: "2.117.3" },
      { name: "yahoo-finance2", version: "4.0.3" },
    ]);
  });
});
