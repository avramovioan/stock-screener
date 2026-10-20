import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { lintWorkflow } from "./lib/workflow-lint.ts";

const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const REQUIRED = ["ci.yml", "deploy-web.yml", "deploy-supabase.yml", "keepalive.yml"];

const problems: string[] = [];
for (const file of REQUIRED) {
  if (!existsSync(join(dir, file))) problems.push(`${file}: workflow is missing`);
}

const files = readdirSync(dir).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
for (const file of files) {
  try {
    problems.push(...lintWorkflow(parse(readFileSync(join(dir, file), "utf8")), file));
  } catch (error) {
    problems.push(
      `${file}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`workflows: ${problem}`);
  process.exit(1);
}
console.log(`workflows: OK (${files.join(", ")})`);
