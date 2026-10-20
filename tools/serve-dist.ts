import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { matchHeaders, parseHeadersFile } from "./lib/headers.ts";

const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const port = Number(portIndex >= 0 ? argv[portIndex + 1] : "4174");
const root = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
if (!existsSync(join(root, "_headers"))) {
  console.error("serve-dist: apps/web/dist/_headers not found; run bun run build first");
  process.exit(1);
}
const rules = parseHeadersFile(readFileSync(join(root, "_headers"), "utf8"));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const candidate = normalize(join(root, pathname));
  const inside =
    candidate === root.slice(0, -1) || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
  const isFile = inside && existsSync(candidate) && statSync(candidate).isFile();
  const file = isFile ? candidate : join(root, "index.html"); // SPA fallback
  const body = readFileSync(file);
  res.writeHead(200, {
    ...matchHeaders(rules, pathname),
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
  });
  res.end(body);
}).listen(port, () =>
  console.log(`serve-dist: http://localhost:${port} (headers from dist/_headers)`),
);
