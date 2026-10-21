import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { buildHeaders } from "../../tools/lib/headers.ts";

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Renders dist/_headers (the CSP connect-src origins) from public/_headers inside the web build, so every
 * build path (root `bun run build`, `cd apps/web && bun run build`, Cloudflare) ships a working CSP.
 * The Supabase URL is the same VITE_SUPABASE_URL the bundle gets. A production build without a valid
 * https URL fails instead of shipping placeholders (SCREENER_ALLOW_PLACEHOLDER_HEADERS=1 opts out).
 */
function renderCspHeaders(): Plugin {
  let root = "";
  let outDir = "dist";
  let mode = "production";
  let supabaseUrl: string | undefined;
  return {
    name: "render-csp-headers",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
      mode = config.mode;
      const value = config.env.VITE_SUPABASE_URL;
      supabaseUrl = typeof value === "string" && value !== "" ? value : undefined;
    },
    writeBundle() {
      const template = readFileSync(resolve(root, "public/_headers"), "utf8");
      const { text, origin, placeholder } = buildHeaders(template, supabaseUrl, {
        mode,
        allowPlaceholder: process.env.SCREENER_ALLOW_PLACEHOLDER_HEADERS === "1",
      });
      writeFileSync(resolve(root, outDir, "_headers"), text);
      console.log(
        `render-csp-headers: connect-src origin ${origin}${placeholder ? " (PLACEHOLDER)" : ""}`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    renderCspHeaders(),
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      // the manifest is a static file in public/ (tested in pwa-assets.test.ts)
      manifest: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest}"],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@core": fromHere("../../supabase/functions/_shared/core"),
      "@": fromHere("./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // the shared core lives outside apps/web, so the dev server must be allowed to serve the repo root
    fs: { allow: [fromHere("../../")] },
  },
  preview: { port: 4173, strictPort: true },
  build: { target: "es2022", sourcemap: false },
});
