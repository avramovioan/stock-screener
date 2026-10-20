// Environment helpers of the local end-to-end suite (P7 Task 4): stack status parsing and the checks on the Edge Function env file.

export const E2E_PASSWORD = "E2e-Passw0rd-9x";
export const OWNER_EMAIL = "e2e-owner@example.test";
export const OTHER_EMAIL = "e2e-other@example.test";

/** The public.invited_emails row for an e2e user: sign-in is invite-only. Lower-case e-mail, no reset. */
export function invitedEmailRow(email: string): {
  email: string;
  reset_password: boolean;
  note: string;
} {
  return { email: email.trim().toLowerCase(), reset_password: false, note: "e2e" };
}

export interface StackKeys {
  url: string;
  anonKey: string;
  serviceKey: string;
}

/** `supabase status -o json` may print status lines before the JSON; key names differ between CLI versions. */
export function parseStackStatus(output: string): StackKeys {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("supabase status printed no JSON object");
  const data = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  const pick = (...names: string[]): string => {
    for (const name of names) {
      const value = data[name];
      if (typeof value === "string" && value !== "") return value;
    }
    throw new Error(`supabase status has none of: ${names.join(", ")}`);
  };
  return {
    url: pick("API_URL"),
    anonKey: pick("ANON_KEY", "PUBLISHABLE_KEY"),
    serviceKey: pick("SERVICE_ROLE_KEY", "SECRET_KEY"),
  };
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** Values the suite needs in `supabase/functions/.env` (the file the local Edge Runtime reads). Names only: generated per developer. */
const REQUIRED_NAMES = [
  "CRON_SHARED_SECRET",
  "FLEX_ENC_KEY_V1",
  "RATE_LIMIT_SALT",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "PUSH_ENDPOINT_EXTRA_HOSTS",
] as const;
const REQUIRED_FLAGS: Record<string, string> = {
  ALLOW_FIXTURE_PROVIDERS: "1",
  FLEX_FIXTURE_MODE: "1",
};

/** Human-readable problems with the functions env file; empty when the suite can run. */
export function missingFunctionEnv(env: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const name of REQUIRED_NAMES) {
    if ((env[name] ?? "") === "") problems.push(`${name} is not set`);
  }
  for (const [name, value] of Object.entries(REQUIRED_FLAGS)) {
    if (env[name] !== value) problems.push(`${name} must be ${value}`);
  }
  return problems;
}

/** The host the fake push endpoint of the notifications spec uses: the first entry of PUSH_ENDPOINT_EXTRA_HOSTS. */
export function pushHost(env: Record<string, string>): string {
  const first = (env.PUSH_ENDPOINT_EXTRA_HOSTS ?? "").split(",")[0]?.trim() ?? "";
  if (first === "")
    throw new Error("PUSH_ENDPOINT_EXTRA_HOSTS is not set in supabase/functions/.env");
  return first;
}

/** The suite deletes users and writes with the service key: it only ever runs against the local stack. */
export function assertLocalStackUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`refusing to run the e2e suite: ${url} is not a URL`);
  }
  if (host !== "127.0.0.1" && host !== "localhost")
    throw new Error(`refusing to run the e2e suite against a non-local stack: ${url}`);
}

export const LOCAL_JWT_ISSUER = "http://127.0.0.1:54321/auth/v1";

/** A message naming the file and the value when the local functions would refuse every local user token; undefined when it is right. */
export function jwtIssuerProblem(env: Record<string, string>): string | undefined {
  if (env.JWT_ISSUER === LOCAL_JWT_ISSUER) return undefined;
  const found = (env.JWT_ISSUER ?? "") === "" ? "is not set" : `is ${env.JWT_ISSUER}`;
  return `supabase/functions/.env: JWT_ISSUER ${found}; set JWT_ISSUER=${LOCAL_JWT_ISSUER} (the issuer of real local sign-ins) and restart the stack (bunx supabase stop, then bunx supabase start)`;
}

/** Reads supabase/functions/.env and throws jwtIssuerProblem when the local issuer is missing or different. */
export function assertLocalJwtIssuer(envFileText: string | undefined): void {
  const problem = jwtIssuerProblem(parseEnvFile(envFileText ?? ""));
  if (problem !== undefined) throw new Error(problem);
}
