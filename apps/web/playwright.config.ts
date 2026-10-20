import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  // e2e/local needs the local Supabase stack; it runs only through `bun run test:e2e:local`
  testIgnore: ["**/local/**"],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // serves the production build (root script test:e2e builds first)
  webServer: [
    {
      command: "bun run preview",
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // the same dist with the headers of dist/_headers applied (csp.spec.ts)
      command: "bun run tools/serve-dist.ts --port 4174",
      cwd: "../..",
      url: "http://localhost:4174/index.html",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
