import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPurityViolations } from "./lib/core-purity.ts";

const coreDir = fileURLToPath(new URL("../supabase/functions/_shared/core/", import.meta.url));
const tscBin = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const canaryFile = join(coreDir, "__purity_canary__.ts");

// Globals that must be compile errors inside core (lib ES2023, types []).
const FORBIDDEN_GLOBALS = ["process", "Deno", "document", "fetch", "setTimeout", "console"];

let failed = false;
const fail = (message: string) => {
  failed = true;
  console.error(`core purity: ${message}`);
};

// 1. Static scan of every non-test core source file.
const sources = readdirSync(coreDir, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .filter((file) => !file.includes("__purity_canary__"));
for (const file of sources) {
  const text = readFileSync(join(coreDir, file), "utf8");
  for (const v of findPurityViolations(text)) {
    fail(`${file}:${v.line} ${v.rule}: ${v.text}`);
  }
}

// 2. Canary: the core tsconfig must reject ambient environment globals.
const canary = [
  "export const a = process.env.X;",
  'export const b = Deno.env.get("X");',
  "export const c = document.title;",
  'export const d = fetch("x");',
  "export const e = setTimeout(() => {}, 1);",
  'console.log("x");',
  "",
].join("\n");
try {
  writeFileSync(canaryFile, canary);
  const result = spawnSync(
    "node",
    [tscBin, "-p", join(coreDir, "tsconfig.json"), "--noEmit", "--pretty", "false"],
    { encoding: "utf8" },
  );
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0) fail("canary compiled; the core tsconfig no longer forbids globals");
  for (const name of FORBIDDEN_GLOBALS) {
    if (!output.includes(`Cannot find name '${name}'`)) {
      fail(`canary did not flag the global '${name}'`);
    }
  }
} finally {
  rmSync(canaryFile, { force: true });
}

if (failed) process.exit(1);
console.log(
  `core purity: OK (${sources.length} files scanned, ${FORBIDDEN_GLOBALS.length} canary globals rejected)`,
);
