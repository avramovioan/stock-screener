import { webEnvProblems } from "./lib/web-env.ts";

const allowLocal = process.argv.includes("--allow-local");
const problems = webEnvProblems(process.env, { allowLocal });
if (problems.length > 0) {
  for (const problem of problems) console.error(`web env: ${problem}`);
  process.exit(1);
}
console.log(`web env: OK${allowLocal ? " (local addresses allowed)" : ""}`);
