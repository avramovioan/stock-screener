import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          environment: "node",
          include: ["supabase/functions/_shared/core/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "tools",
          environment: "node",
          include: ["tools/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@core": fromRoot("./supabase/functions/_shared/core"),
            "@": fromRoot("./apps/web/src"),
          },
        },
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/web/src/test/setup.ts"],
        },
      },
    ],
  },
});
