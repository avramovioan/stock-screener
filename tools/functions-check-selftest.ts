import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const functionsDir = fileURLToPath(new URL("../supabase/functions/", import.meta.url));

// Each probe is an extensionless relative import, which Deno rejects; one per glob that
// `functions:check` must cover (adapters, core, a function entrypoint).
const BAD_SOURCE = 'import { missing } from "./does-not-exist";\nexport const value = missing;\n';
const PROBES = [
  "_shared/adapters/__selftest_adapters__.ts",
  "_shared/core/__selftest_core__.ts",
  "__selftest_fn__/index.ts",
];

function runCheck() {
  const result = spawnSync(process.execPath, ["run", "functions:check"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let failed = false;
const fail = (message: string) => {
  failed = true;
  console.error(`functions:check self-test: ${message}`);
};

const baseline = runCheck();
if (baseline.status !== 0) fail(`baseline run is not green:\n${baseline.output}`);

try {
  for (const probe of PROBES) {
    const path = `${functionsDir}${probe}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, BAD_SOURCE);
  }
  const broken = runCheck();
  if (broken.status === 0)
    fail("a broken import did not fail `functions:check` (globs match nothing?)");
  for (const probe of PROBES) {
    const name =
      probe.split("/")[0] === "__selftest_fn__"
        ? "__selftest_fn__"
        : (probe.split("/").pop() ?? probe);
    if (!broken.output.includes(name)) fail(`the probe ${probe} was not type-checked`);
  }
} finally {
  rmSync(`${functionsDir}_shared/adapters/__selftest_adapters__.ts`, { force: true });
  rmSync(`${functionsDir}_shared/core/__selftest_core__.ts`, { force: true });
  rmSync(`${functionsDir}__selftest_fn__`, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log(
  "functions:check self-test: OK (broken adapter, core and function files are all rejected)",
);
