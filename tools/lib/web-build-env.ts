import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const WEB_DIR = fileURLToPath(new URL("../../apps/web", import.meta.url));

/**
 * VITE_* variables as `vite build` (mode production) sees them: the process environment wins,
 * then apps/web/.env, .env.local, .env.production, .env.production.local (later overrides earlier).
 */
export function webBuildEnv(dir: string = WEB_DIR): Record<string, string> {
  return loadEnv("production", dir, "VITE_");
}

export function webBuildSupabaseUrl(dir?: string): string | undefined {
  const value = webBuildEnv(dir).VITE_SUPABASE_URL;
  return value === undefined || value === "" ? undefined : value;
}
