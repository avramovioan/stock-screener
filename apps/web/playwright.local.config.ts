import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import {
  assertLocalStackUrl,
  parseEnvFile,
  parseStackStatus,
  pushHost,
} from "../../tools/lib/e2e-env.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const status = parseStackStatus(
  execSync("bunx supabase status -o json", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
const envFile = fileURLToPath(new URL("../../supabase/functions/.env", import.meta.url));
const functionsEnv = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};

assertLocalStackUrl(status.url); // the specs delete users and use the service key

// Values the specs and the dev server need. The service key is used by the specs only (API calls), never by the browser bundle.
process.env.VITE_SUPABASE_URL = status.url;
process.env.VITE_SUPABASE_ANON_KEY = status.anonKey;
process.env.VITE_SITE_URL = "http://localhost:5173";
process.env.VITE_VAPID_PUBLIC_KEY = functionsEnv.VAPID_PUBLIC_KEY ?? "";
process.env.E2E_SUPABASE_URL = status.url;
process.env.E2E_SERVICE_ROLE_KEY = status.serviceKey;
process.env.E2E_CRON_SECRET = functionsEnv.CRON_SHARED_SECRET ?? "local-dev-cron-secret";
process.env.E2E_PUSH_HOST = pushHost(functionsEnv);

const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);

// The Vite dev server on the one origin the local auth allow-list knows (http://localhost:5173): stop any other dev server first.
// One worker: the specs share one database and the 60 s and 10 minute cooldowns.
export default defineConfig({
  testDir: "./e2e/local",
  testMatch: "**/*.local.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: { baseURL: "http://localhost:5173", trace: "on-first-retry", serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 60_000,
    env: inherited,
  },
});
