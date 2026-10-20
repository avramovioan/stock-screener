/** The import map every function's deno.json must carry (spec 3.6). */
export const FUNCTION_IMPORTS = {
  "@core/": "../_shared/core/",
  "@adapters/": "../_shared/adapters/",
  "@supabase/supabase-js": "npm:@supabase/supabase-js@2.117.3",
} as const;

/** Text of the canonical per-function deno.json. */
export function functionDenoJson(): string {
  return `${JSON.stringify({ imports: FUNCTION_IMPORTS, nodeModulesDir: "none" }, null, 2)}\n`;
}

/** Minimal TOML reader: section name -> (key -> raw value). Enough for supabase/config.toml checks. */
export function parseToml(toml: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = new Map<string, string>();
  sections.set("", current);
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header?.[1] !== undefined) {
      current = sections.get(header[1]) ?? new Map<string, string>();
      sections.set(header[1], current);
      continue;
    }
    const equals = line.indexOf("=");
    if (equals > 0) {
      const key = line.slice(0, equals).trim();
      const value = line
        .slice(equals + 1)
        .replace(/\s+#.*$/, "")
        .trim();
      current.set(key, value);
    }
  }
  return sections;
}

export interface FunctionsConfigInput {
  /** directory names under supabase/functions, without the `_shared` folder */
  functionDirs: string[];
  /** contents of supabase/config.toml */
  toml: string;
  /** parsed deno.json per function directory; undefined when missing or invalid */
  denoJson: Record<string, unknown>;
  hasIndex: Record<string, boolean>;
}

function sameImports(actual: unknown): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const entries = (value: object) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return entries(actual) === entries(FUNCTION_IMPORTS);
}

/** Returns a list of human-readable problems; an empty list means the configuration is consistent. */
export function checkFunctionsConfig(input: FunctionsConfigInput): string[] {
  const problems: string[] = [];
  const toml = parseToml(input.toml);

  if (toml.get("edge_runtime")?.get("policy") !== '"per_worker"') {
    problems.push(
      '[edge_runtime] policy must be "per_worker" (EdgeRuntime.waitUntil needs it locally)',
    );
  }

  for (const name of input.functionDirs) {
    if (input.hasIndex[name] !== true) problems.push(`${name}: index.ts is missing`);

    const deno = input.denoJson[name];
    if (typeof deno !== "object" || deno === null) {
      problems.push(`${name}: deno.json is missing or not valid JSON`);
    } else {
      const record = deno as { imports?: unknown; nodeModulesDir?: unknown };
      if (!sameImports(record.imports)) {
        problems.push(`${name}: deno.json imports differ from the canonical import map`);
      }
      if (record.nodeModulesDir !== "none") {
        problems.push(`${name}: deno.json must set "nodeModulesDir": "none"`);
      }
    }

    const block = toml.get(`functions.${name}`);
    if (block === undefined) {
      problems.push(`${name}: missing [functions.${name}] block in supabase/config.toml`);
    } else if (block.get("verify_jwt") !== "false") {
      problems.push(`${name}: verify_jwt must be false (authentication is done in code)`);
    }
  }

  for (const section of toml.keys()) {
    if (!section.startsWith("functions.")) continue;
    const name = section.slice("functions.".length);
    if (!input.functionDirs.includes(name)) {
      problems.push(`${name}: [functions.${name}] has no directory under supabase/functions`);
    }
  }
  return problems;
}
