import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type HeaderMode, headerProblems, originOf, parseHeadersFile } from "./lib/headers.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const template = args.includes("--template");
const file = fileURLToPath(
  new URL(template ? "../apps/web/public/_headers" : "../apps/web/dist/_headers", import.meta.url),
);
if (!existsSync(file)) {
  console.error(`check:headers: ${file} not found${template ? "" : " (run bun run build first)"}`);
  process.exit(1);
}
const expectedSource = flag("expect-origin") ?? process.env.VITE_SUPABASE_URL;
const expectedOrigin =
  expectedSource === undefined ? undefined : (originOf(expectedSource) ?? undefined);
const mode: HeaderMode = template
  ? { mode: "template" }
  : expectedOrigin === undefined
    ? { mode: "rendered" }
    : { mode: "rendered", expectedOrigin };
const problems = headerProblems(parseHeadersFile(readFileSync(file, "utf8")), mode);
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:headers: ${problem}`);
  process.exit(1);
}
console.log(
  `check:headers: OK (${template ? "template" : "rendered"}${expectedOrigin === undefined ? "" : `, origin ${expectedOrigin}`})`,
);
