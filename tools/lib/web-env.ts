import { scanText } from "./secret-scan.ts";

const REQUIRED = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_SITE_URL"] as const;
const URL_VARIABLES = ["VITE_SUPABASE_URL", "VITE_SITE_URL"] as const;
const SECRET_NAME = /SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|TOKEN|FLEX_ENC|API_KEY/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/;

export interface WebEnvOptions {
  /** accept localhost and http URLs (local production-mode builds) */
  allowLocal?: boolean;
}

/**
 * Problems that would make a deployed bundle broken or unsafe. Values are never echoed, only
 * variable names, so the output is safe in CI logs.
 */
export function webEnvProblems(
  env: Record<string, string | undefined>,
  options: WebEnvOptions = {},
): string[] {
  const allowLocal = options.allowLocal ?? false;
  const problems: string[] = [];

  for (const name of REQUIRED) {
    if ((env[name] ?? "").trim() === "") problems.push(`${name} is empty or not set`);
  }

  for (const name of URL_VARIABLES) {
    const value = (env[name] ?? "").trim();
    if (value === "") continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${name} is not a valid URL`);
      continue;
    }
    if (!allowLocal) {
      if (LOCAL_HOST.test(url.hostname)) problems.push(`${name} points at a local address`);
      if (url.protocol !== "https:") problems.push(`${name} must use https`);
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("VITE_")) continue;
    if (SECRET_NAME.test(name)) {
      problems.push(`${name} looks like a secret and would be embedded in the browser bundle`);
    }
    if (value !== undefined && scanText(value).length > 0) {
      problems.push(`${name} contains a service-role key`);
    }
  }
  return problems;
}
