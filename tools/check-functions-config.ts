import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFunctionsConfig } from "./lib/functions-config.ts";

const functionsDir = fileURLToPath(new URL("../supabase/functions/", import.meta.url));
const configPath = fileURLToPath(new URL("../supabase/config.toml", import.meta.url));

const functionDirs = readdirSync(functionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => entry.name);

const denoJson: Record<string, unknown> = {};
const hasIndex: Record<string, boolean> = {};
for (const name of functionDirs) {
  hasIndex[name] = existsSync(join(functionsDir, name, "index.ts"));
  try {
    denoJson[name] = JSON.parse(readFileSync(join(functionsDir, name, "deno.json"), "utf8"));
  } catch {
    denoJson[name] = undefined;
  }
}

const problems = checkFunctionsConfig({
  functionDirs,
  toml: readFileSync(configPath, "utf8"),
  denoJson,
  hasIndex,
});
if (problems.length > 0) {
  for (const problem of problems) console.error(`functions config: ${problem}`);
  process.exit(1);
}
console.log(`functions config: OK (${functionDirs.join(", ")})`);
