export interface Suite {
  name: string;
  command: string;
  args: string[];
  /** The suite needs the local stack ("stack") or the stack plus served functions ("functions"), or the network ("network"). */
  needs?: "stack" | "functions" | "network";
}

const bun = (name: string, script: string, needs?: Suite["needs"]): Suite => ({
  name,
  command: "bun",
  args: ["run", script],
  ...(needs === undefined ? {} : { needs }),
});

// The suites run strictly one after the other (the runner never starts two). `check:guide` is not in the list: the script was never built
// (see docs/discovery/p7-results.md).
export const SUITES: Suite[] = [
  bun("lint", "lint"),
  bun("lint-workflows", "lint:workflows"),
  bun("typecheck", "typecheck"),
  bun("test-core", "test:core"),
  bun("test-tools", "test:tools"),
  bun("test-web", "test:web"),
  bun("check-functions-config", "check:functions-config"),
  bun("functions-check", "functions:check"),
  bun("functions-test", "functions:test"),
  bun("functions-selftest", "functions:selftest"),
  bun("check-fetch", "check:fetch"),
  bun("check-secrets", "check:secrets"),
  bun("audit", "audit", "network"),
  bun("build", "build"),
  bun("check-bundle", "check:bundle"),
  bun("check-headers", "check:headers"),
  bun("test-e2e", "test:e2e"),
  bun("test-db", "test:db", "stack"),
  bun("test-integration", "test:integration", "functions"),
  bun("test-e2e-local", "test:e2e:local", "functions"),
];

export interface VerifyResult {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  skipped?: string;
}

export function selectSuites(only: string[], skip: string[]): Suite[] {
  for (const name of [...only, ...skip]) {
    if (!SUITES.some((s) => s.name === name)) throw new Error(`unknown suite ${name}`);
  }
  return SUITES.filter(
    (s) => (only.length === 0 || only.includes(s.name)) && !skip.includes(s.name),
  );
}

export function summarizeOutput(name: string, output: string): string {
  const failedVitest = /Tests\s+(\d+) failed \| (\d+) passed/.exec(output);
  if (failedVitest) return `${failedVitest[1]} failed, ${failedVitest[2]} passed`;
  const vitest = /Tests\s+(\d+) passed/.exec(output);
  if (vitest) return `${vitest[1]} tests passed`;
  const deno = /ok \| (\d+) passed \| (\d+) failed/.exec(output);
  if (deno) return `${deno[1]} passed, ${deno[2]} failed`;
  const pg = /Files=(\d+), Tests=(\d+)/.exec(output);
  if (pg) return `${pg[1]} files, ${pg[2]} tests, ${/Result: (\w+)/.exec(output)?.[1] ?? "?"}`;
  const pw = /(\d+) passed \(/.exec(output);
  if (pw && (name.startsWith("test-e2e") || name === "build")) return `${pw[1]} passed`;
  const biome = /Checked (\d+) files/.exec(output);
  if (biome) return `${biome[1]} files checked`;
  return "";
}

export function renderTable(results: VerifyResult[]): string {
  const rows = results.map((r) => {
    const status =
      r.skipped !== undefined
        ? `SKIPPED (${r.skipped})`
        : r.exitCode === 0
          ? "PASS"
          : `FAIL (exit ${r.exitCode})`;
    return `| ${r.name} | \`${r.command}\` | ${status} | ${r.summary} | ${(r.durationMs / 1000).toFixed(1)} s | \`docs/discovery/p7-evidence/${r.name}.txt\` |`;
  });
  return [
    "| Suite | Command | Result | Summary | Time | Evidence |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export function replaceBetweenMarkers(text: string, marker: string, replacement: string): string {
  const begin = `<!-- ${marker}:begin -->`;
  const end = `<!-- ${marker}:end -->`;
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`markers ${begin} and ${end} not found`);
  return `${text.slice(0, from + begin.length)}\n${replacement}\n${text.slice(to)}`;
}
