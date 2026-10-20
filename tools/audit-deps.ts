import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Advisory,
  type AuditException,
  auditProblems,
  parseBunAudit,
  parseNpmAudit,
  specifiersFromSource,
} from "./lib/audit.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const advisories: Advisory[] = [];

// 1. production dependencies of the workspace, resolved by bun.lock
const bun = spawnSync("bun", ["audit", "--json", "--prod"], {
  cwd: root,
  encoding: "utf8",
  shell: true,
});
try {
  advisories.push(...parseBunAudit(JSON.parse(bun.stdout || "{}")));
} catch {
  console.error(
    `audit: could not read the output of "bun audit" (exit ${bun.status}): ${(bun.stderr || bun.stdout).slice(0, 300)}`,
  );
  process.exit(2);
}

// 2. npm: specifiers of the Edge Functions, resolved exactly as pinned
const functions = join(root, "supabase", "functions");
const specifiers = new Map<string, string>();
for (const file of readdirSync(functions, { recursive: true, encoding: "utf8" })) {
  if (!(file.endsWith(".ts") || file.endsWith("deno.json")) || file.includes("node_modules"))
    continue;
  for (const s of specifiersFromSource(readFileSync(join(functions, file), "utf8")))
    specifiers.set(s.name, s.version);
}
if (specifiers.size > 0) {
  const dir = mkdtempSync(join(tmpdir(), "deno-audit-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "deno-deps",
      version: "0.0.0",
      private: true,
      dependencies: Object.fromEntries(specifiers),
    }),
  );
  const install = spawnSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: dir,
      encoding: "utf8",
      shell: true,
    },
  );
  if (install.status !== 0) {
    console.error(
      `audit: npm could not resolve the Deno dependencies: ${install.stderr.slice(0, 300)}`,
    );
    process.exit(2);
  }
  const npm = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: dir,
    encoding: "utf8",
    shell: true,
  });
  let npmJson: unknown;
  try {
    npmJson = JSON.parse(npm.stdout || "{}");
  } catch {
    console.error(
      `audit: could not read the output of "npm audit" (exit ${npm.status}): ${(npm.stderr || npm.stdout).slice(0, 300)}`,
    );
    process.exit(2);
  }
  if (typeof npmJson === "object" && npmJson !== null && "error" in npmJson) {
    console.error(
      `audit: npm audit failed: ${JSON.stringify((npmJson as { error: unknown }).error).slice(0, 300)}`,
    );
    process.exit(2);
  }
  advisories.push(...parseNpmAudit(npmJson));
}

const exceptions = (
  JSON.parse(readFileSync(join(root, "tools", "audit-exceptions.json"), "utf8")) as {
    exceptions: AuditException[];
  }
).exceptions;
const { problems, warnings } = auditProblems(advisories, exceptions, Date.now());
for (const warning of warnings) console.warn(`audit: ${warning}`);
for (const a of advisories) console.log(`audit: ${a.severity} ${a.id} ${a.pkg}: ${a.title}`);
console.log(
  `audit: ${advisories.length} advisories (${advisories.filter((a) => a.severity === "high" || a.severity === "critical").length} high or critical), ${specifiers.size} Deno npm packages`,
);
if (problems.length > 0) {
  for (const problem of problems) console.error(`audit: ${problem}`);
  process.exit(1);
}
console.log("audit: OK");
