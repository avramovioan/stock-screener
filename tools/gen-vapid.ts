import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { generateVapid, parseGenVapidArgs } from "./lib/vapid.ts";

// usage: bun run gen:vapid -- mailto:you@example.com [--out supabase/functions/.env.vapid]
const { subject, outPath } = parseGenVapidArgs(process.argv.slice(2));

if (!/^(mailto:|https:\/\/)/.test(subject)) {
  console.error("usage: bun run gen:vapid -- mailto:you@example.com [--out <.env-file>]");
  process.exit(1);
}
if (outPath !== undefined && !basename(outPath).startsWith(".env")) {
  console.error(
    "--out must name a git-ignored .env* file (for example supabase/functions/.env.vapid)",
  );
  process.exit(1);
}

const keys = await generateVapid();
const lines = keys.envLines(subject);
if (outPath === undefined) {
  console.log(lines);
} else {
  writeFileSync(outPath, `${lines}\n`, { mode: 0o600 });
  console.error(`wrote ${outPath}`);
}
console.error(
  [
    "",
    "Next steps (the private key must exist only as a function secret):",
    "  supabase secrets set --env-file <the .env file above> --project-ref <ref>",
    "  put VITE_VAPID_PUBLIC_KEY into the web build environment (it is public)",
    "  delete the .env file when the secrets are set",
  ].join("\n"),
);
