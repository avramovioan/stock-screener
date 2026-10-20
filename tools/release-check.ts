import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EvidenceSummary,
  evidenceProblems,
  gitProblems,
  trackedForbiddenFiles,
  unresolvedMarkers,
} from "./lib/release-check.ts";
import { SUITES } from "./lib/verify-all.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args: string[]): string =>
  spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();

const counts = git("rev-list", "--left-right", "--count", "master...build/initial")
  .split(/\s+/)
  .map(Number);
const problems = [
  ...gitProblems({
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    porcelain: git("status", "--porcelain"),
    behind: counts[0] ?? 0,
    ahead: counts[1] ?? 0,
    tagExists: git("tag", "--list", "v0.1.0-local") !== "",
  }),
  ...trackedForbiddenFiles(git("ls-files").split(/\r?\n/)).map(
    (f) => `tracked file that must never be committed: ${f}`,
  ),
];
const results = join(root, "docs", "discovery", "p7-results.md");
if (!existsSync(results)) problems.push("docs/discovery/p7-results.md is missing");
else
  problems.push(
    ...unresolvedMarkers(readFileSync(results, "utf8")).map((m) => `p7-results.md: ${m}`),
  );
const summaryFile = join(root, "docs", "discovery", "p7-evidence", "summary.json");
if (!existsSync(summaryFile))
  problems.push("docs/discovery/p7-evidence/summary.json is missing (run bun run verify:all)");
else
  problems.push(
    ...evidenceProblems(
      JSON.parse(readFileSync(summaryFile, "utf8")) as EvidenceSummary,
      SUITES.map((s) => s.name),
    ),
  );

if (problems.length > 0) {
  for (const problem of problems) console.error(`release:check: ${problem}`);
  process.exit(1);
}
console.log(
  "release:check: OK (no push is performed by the release steps; the owner pushes when ready)",
);
