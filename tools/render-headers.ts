import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderHeaders } from "./lib/headers.ts";
import { webBuildSupabaseUrl } from "./lib/web-build-env.ts";

const source = fileURLToPath(new URL("../apps/web/public/_headers", import.meta.url));
const target = fileURLToPath(new URL("../apps/web/dist/_headers", import.meta.url));
if (!existsSync(target)) {
  console.error("render:headers: apps/web/dist/_headers not found; run the web build first");
  process.exit(1);
}
const { text, origin, placeholder } = renderHeaders(
  readFileSync(source, "utf8"),
  webBuildSupabaseUrl(),
);
writeFileSync(target, text);
console.log(
  `render:headers: connect-src origin ${origin}${placeholder ? " (PLACEHOLDER: VITE_SUPABASE_URL is not a valid https URL; never deploy this build)" : ""}`,
);
