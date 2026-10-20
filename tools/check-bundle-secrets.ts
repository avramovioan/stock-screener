import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "./lib/secret-scan.ts";

const distDir = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".html",
  ".map",
  ".json",
  ".webmanifest",
  ".txt",
  ".svg",
]);

if (!existsSync(distDir)) {
  console.error("bundle secret scan: apps/web/dist not found; run `bun run build` first");
  process.exit(1);
}

let scanned = 0;
let failed = false;
for (const file of readdirSync(distDir, { recursive: true, encoding: "utf8" })) {
  const full = join(distDir, file);
  if (!TEXT_EXTENSIONS.has(extname(file)) || !statSync(full).isFile()) continue;
  scanned += 1;
  for (const finding of scanText(readFileSync(full, "utf8"))) {
    failed = true;
    console.error(`bundle secret scan: ${file}: ${finding.rule} (${finding.detail})`);
  }
}

if (failed) process.exit(1);
console.log(`bundle secret scan: OK (${scanned} files)`);
