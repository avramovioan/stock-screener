import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPolicyProblems } from "./lib/fetch-callsites.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = join(root, "supabase", "functions");
const files = readdirSync(base, { recursive: true, encoding: "utf8" })
  .filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      !f.includes("fixtures") &&
      !f.includes("node_modules"),
  )
  .map((f) => ({
    file: `supabase/functions/${f.split("\\").join("/")}`,
    text: readFileSync(join(base, f), "utf8"),
  }));
const { problems, stale } = fetchPolicyProblems(files);
for (const entry of stale)
  console.warn(
    `check:fetch: policy entry without a call site (remove it if the file is gone): ${entry}`,
  );
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:fetch: ${problem}`);
  process.exit(1);
}
console.log(`check:fetch: OK (${files.length} files scanned)`);
