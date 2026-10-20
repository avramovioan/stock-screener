import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [
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
