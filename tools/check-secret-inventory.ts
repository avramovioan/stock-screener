import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envNamesInSource, inventoryProblems } from "./lib/secret-inventory.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const functions = join(root, "supabase", "functions");
const sources = readdirSync(functions, { recursive: true, encoding: "utf8" }).filter(
  (f) =>
    f.endsWith(".ts") &&
    !f.endsWith(".test.ts") &&
    !f.includes("fixtures") &&
    !f.includes("node_modules"),
);
const codeNames = sources.flatMap((f) =>
  envNamesInSource(readFileSync(join(functions, f), "utf8")),
);
const guide = join(root, "docs", "operator-guide.md");
const exampleFiles = ["supabase/functions/.env.example", "apps/web/.env.example"]
  .filter((p) => existsSync(join(root, p)))
  .map((p) => ({ path: p, text: readFileSync(join(root, p), "utf8") }));

const problems = inventoryProblems({
  codeNames,
  guideText: existsSync(guide) ? readFileSync(guide, "utf8") : "",
  exampleFiles,
});
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:secrets: ${problem}`);
  process.exit(1);
}
console.log(
  `check:secrets: OK (${new Set(codeNames).size} environment names, ${exampleFiles.length} example files)`,
);
