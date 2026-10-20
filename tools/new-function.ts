import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { functionDenoJson } from "./lib/functions-config.ts";

const name = process.argv[2];
if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("usage: bun run tools/new-function.ts <function-name>");
  process.exit(1);
}

const dir = fileURLToPath(new URL(`../supabase/functions/${name}/`, import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "deno.json"), functionDenoJson());

const indexPath = join(dir, "index.ts");
if (!existsSync(indexPath)) {
  writeFileSync(
    indexPath,
    [
      'import { json } from "@adapters/http.ts";',
      "",
      "// P0 placeholder so config and deploy checks cover the final function set.",
      "// The real implementation arrives in a later phase; replace this file then.",
      `Deno.serve(() => json({ error: "not_implemented", function: "${name}" }, { status: 501 }));`,
      "",
    ].join("\n"),
  );
}
console.log(`function ${name}: ready`);
