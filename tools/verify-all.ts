// Runs every suite strictly one at a time and records the evidence (exit code, last 120 lines) under docs/discovery/p7-evidence/.
// `bun run verify:all [-- --only a,b] [-- --skip c]`. Partial runs (--only) merge into the existing summary.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderTable,
  replaceBetweenMarkers,
  SUITES,
  selectSuites,
  summarizeOutput,
  type VerifyResult,
} from "./lib/verify-all.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const list = (name: string): string[] => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined
    ? (args[i + 1] as string).split(",").filter(Boolean)
    : [];
};
const outDir = join(root, "docs", "discovery", "p7-evidence");
mkdirSync(outDir, { recursive: true });

const stackUp =
  spawnSync("bunx", ["supabase", "status", "-o", "json"], {
    cwd: root,
    shell: true,
    stdio: "pipe",
  }).status === 0;
async function functionsUp(): Promise<boolean> {
  try {
    return (
      await fetch("http://127.0.0.1:54321/functions/v1/health", {
        signal: AbortSignal.timeout(3000),
      })
    ).ok;
  } catch {
    return false;
  }
}
const functions = stackUp && (await functionsUp());
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const results: VerifyResult[] = [];
for (const suite of selectSuites(list("only"), list("skip"))) {
  const command = `${suite.command} ${suite.args.join(" ")}`;
  const missing =
    suite.needs === "stack" && !stackUp
      ? "local stack not running"
      : suite.needs === "functions" && !functions
        ? "local stack or served functions not running"
        : undefined;
  if (missing !== undefined) {
    results.push({
      name: suite.name,
      command,
      exitCode: null,
      durationMs: 0,
      summary: "",
      skipped: missing,
    });
    writeFileSync(join(outDir, `${suite.name}.txt`), `$ ${command}\nSKIPPED: ${missing}\n`);
    console.log(`SKIP ${suite.name}: ${missing}`);
    continue;
  }
  console.log(`RUN  ${suite.name}: ${command}`);
  const started = Date.now();
  const run = spawnSync(suite.command, suite.args, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.replace(ansi, "");
  const tail = output.split(/\r?\n/).slice(-120).join("\n");
  writeFileSync(
    join(outDir, `${suite.name}.txt`),
    `$ ${command}\nexit code: ${run.status}\nduration: ${(durationMs / 1000).toFixed(1)} s\nfinished: ${new Date().toISOString()}\n--- last 120 lines ---\n${tail}\n`,
  );
  const summary = summarizeOutput(suite.name, output);
  results.push({ name: suite.name, command, exitCode: run.status, durationMs, summary });
  console.log(`${run.status === 0 ? "PASS" : "FAIL"} ${suite.name} ${summary}`);
}

// A partial run keeps the other suites' earlier results, in suite order.
const summaryFile = join(outDir, "summary.json");
let merged = results;
if (list("only").length > 0 || list("skip").length > 0) {
  try {
    const previous = (JSON.parse(readFileSync(summaryFile, "utf8")) as { results: VerifyResult[] })
      .results;
    merged = SUITES.map(
      (s) => results.find((r) => r.name === s.name) ?? previous.find((r) => r.name === s.name),
    ).filter((r): r is VerifyResult => r !== undefined);
  } catch {
    merged = results;
  }
}
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
writeFileSync(
  summaryFile,
  `${JSON.stringify({ at: new Date().toISOString(), commit, results: merged }, null, 2)}\n`,
);
const table = renderTable(merged);
writeFileSync(join(outDir, "summary.md"), `${table}\n`);
const doc = join(root, "docs", "discovery", "p7-results.md");
if (existsSync(doc)) {
  try {
    writeFileSync(doc, replaceBetweenMarkers(readFileSync(doc, "utf8"), "suites", table));
  } catch {
    console.warn("verify:all: docs/discovery/p7-results.md has no suite markers");
  }
}
const failed = results.filter((r) => r.skipped === undefined && r.exitCode !== 0);
if (failed.length > 0) {
  console.error(
    `verify:all: ${failed.length} suite(s) failed: ${failed.map((f) => f.name).join(", ")}`,
  );
  process.exit(1);
}
console.log(
  `verify:all: ${results.length} suites, ${results.filter((r) => r.skipped !== undefined).length} skipped`,
);
