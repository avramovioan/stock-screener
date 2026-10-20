import { describe, expect, it } from "vitest";
import {
  checkFunctionsConfig,
  FUNCTION_IMPORTS,
  functionDenoJson,
  parseToml,
} from "./functions-config.ts";

const goodToml = `
[edge_runtime]
enabled = true
policy = "per_worker"   # keeps waitUntil alive locally

[functions.health]
verify_jwt = false

[functions.worker-tick]
verify_jwt = false
`;

const goodDeno = { imports: FUNCTION_IMPORTS, nodeModulesDir: "none" };

const base = {
  functionDirs: ["health", "worker-tick"],
  toml: goodToml,
  denoJson: { health: goodDeno, "worker-tick": goodDeno },
  hasIndex: { health: true, "worker-tick": true },
};

describe("parseToml", () => {
  it("reads sections, strips comments and keeps raw values", () => {
    const toml = parseToml(goodToml);
    expect(toml.get("edge_runtime")?.get("policy")).toBe('"per_worker"');
    expect(toml.get("functions.health")?.get("verify_jwt")).toBe("false");
  });
});

describe("functionDenoJson", () => {
  it("renders the canonical per-function deno.json", () => {
    const parsed = JSON.parse(functionDenoJson());
    expect(parsed.imports).toEqual(FUNCTION_IMPORTS);
    expect(parsed.nodeModulesDir).toBe("none");
    expect(functionDenoJson().endsWith("\n")).toBe(true);
  });
});

describe("checkFunctionsConfig", () => {
  it("accepts a consistent configuration", () => {
    expect(checkFunctionsConfig(base)).toEqual([]);
  });

  it("flags a function without a [functions.x] block", () => {
    const problems = checkFunctionsConfig({
      ...base,
      toml: '[edge_runtime]\npolicy = "per_worker"\n',
    });
    expect(problems).toContain("health: missing [functions.health] block in supabase/config.toml");
  });

  it("flags verify_jwt other than false", () => {
    const toml = goodToml.replace(
      "[functions.health]\nverify_jwt = false",
      "[functions.health]\nverify_jwt = true",
    );
    expect(checkFunctionsConfig({ ...base, toml })).toContain(
      "health: verify_jwt must be false (authentication is done in code)",
    );
  });

  it("flags a config block whose directory does not exist", () => {
    const problems = checkFunctionsConfig({
      ...base,
      toml: `${goodToml}\n[functions.ghost]\nverify_jwt = false\n`,
    });
    expect(problems).toContain(
      "ghost: [functions.ghost] has no directory under supabase/functions",
    );
  });

  it("flags a missing or drifted deno.json", () => {
    const drifted = {
      imports: { ...FUNCTION_IMPORTS, "@core/": "../elsewhere/" },
      nodeModulesDir: "none",
    };
    expect(
      checkFunctionsConfig({ ...base, denoJson: { health: drifted, "worker-tick": goodDeno } }),
    ).toContain("health: deno.json imports differ from the canonical import map");
    expect(
      checkFunctionsConfig({ ...base, denoJson: { health: undefined, "worker-tick": goodDeno } }),
    ).toContain("health: deno.json is missing or not valid JSON");
  });

  it("flags a function without index.ts", () => {
    expect(
      checkFunctionsConfig({ ...base, hasIndex: { health: false, "worker-tick": true } }),
    ).toContain("health: index.ts is missing");
  });

  it("flags an edge runtime policy other than per_worker", () => {
    const toml = goodToml.replace('policy = "per_worker"', 'policy = "oneshot"');
    expect(checkFunctionsConfig({ ...base, toml })).toContain(
      '[edge_runtime] policy must be "per_worker" (EdgeRuntime.waitUntil needs it locally)',
    );
  });
});
