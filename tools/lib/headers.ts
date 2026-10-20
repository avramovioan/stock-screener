export const ORIGIN_TOKEN = "__SUPABASE_ORIGIN__";
export const WS_ORIGIN_TOKEN = "__SUPABASE_WS_ORIGIN__";
export const PLACEHOLDER_ORIGIN = "https://unset.invalid";

export type HeaderRules = Map<string, Map<string, string>>;
export type HeaderMode = { mode: "template" } | { mode: "rendered"; expectedOrigin?: string };

/** Cloudflare `_headers` syntax: an unindented path rule followed by indented `Name: value` lines. */
export function parseHeadersFile(text: string): HeaderRules {
  const rules: HeaderRules = new Map();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const key = raw.trim();
      current = rules.get(key) ?? new Map<string, string>();
      rules.set(key, current);
      continue;
    }
    if (current === null) throw new Error(`header line before any path rule: ${raw.trim()}`);
    const colon = raw.indexOf(":");
    if (colon < 0) throw new Error(`header line without a colon: ${raw.trim()}`);
    const name = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    current.set(name, current.has(name) ? `${current.get(name)}, ${value}` : value);
  }
  return rules;
}

export function parseCsp(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [name, ...sources] = tokens;
    if (name !== undefined) out.set(name.toLowerCase(), sources);
  }
  return out;
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The Realtime websocket origin of an https origin: same host, wss scheme. */
export function wsOriginOf(origin: string): string {
  return origin.replace(/^https:/, "wss:");
}

export function renderHeaders(
  template: string,
  supabaseUrl: string | undefined,
): { text: string; origin: string; placeholder: boolean } {
  if (!template.includes(ORIGIN_TOKEN))
    throw new Error(`template does not contain the origin token ${ORIGIN_TOKEN}`);
  const origin = supabaseUrl === undefined ? null : originOf(supabaseUrl);
  const chosen = origin ?? PLACEHOLDER_ORIGIN;
  return {
    text: template.split(ORIGIN_TOKEN).join(chosen).split(WS_ORIGIN_TOKEN).join(wsOriginOf(chosen)),
    origin: chosen,
    placeholder: origin === null,
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Headers that apply to a path: every matching rule, in file order; equal names are joined with ", ". */
export function matchHeaders(rules: HeaderRules, pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pattern, headers] of rules) {
    if (!globToRegExp(pattern).test(pathname)) continue;
    for (const [name, value] of headers) out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

const EXACT: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
};
const SUBSET: Record<string, string[]> = {
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
};

export function cspProblems(value: string, mode: HeaderMode): string[] {
  const problems: string[] = [];
  const csp = parseCsp(value);
  for (const [name, expected] of Object.entries(EXACT)) {
    const actual = csp.get(name);
    if (actual === undefined) problems.push(`CSP: ${name} is missing`);
    else if (actual.join(" ") !== expected.join(" "))
      problems.push(
        `CSP: ${name} must be exactly ${expected.join(" ")} (found ${actual.join(" ")})`,
      );
  }
  for (const [name, allowed] of Object.entries(SUBSET)) {
    const actual = csp.get(name);
    if (actual === undefined) problems.push(`CSP: ${name} is missing`);
    else
      for (const source of actual)
        if (!allowed.includes(source)) problems.push(`CSP: ${name} must not contain ${source}`);
  }
  const connect = csp.get("connect-src");
  if (connect === undefined) problems.push("CSP: connect-src is missing");
  else {
    const [self, origin, ws, ...rest] = connect;
    if (self !== "'self'") problems.push("CSP: connect-src must start with 'self'");
    if (rest.length > 0 || origin === undefined || ws === undefined)
      problems.push(
        `CSP: connect-src must be 'self' plus exactly the https origin and its wss origin (found ${connect.join(" ")})`,
      );
    else if (mode.mode === "template") {
      if (origin !== ORIGIN_TOKEN)
        problems.push(`CSP: the template connect-src origin must be ${ORIGIN_TOKEN}`);
      if (ws !== WS_ORIGIN_TOKEN)
        problems.push(`CSP: the template connect-src websocket origin must be ${WS_ORIGIN_TOKEN}`);
    } else if (origin.includes(ORIGIN_TOKEN) || ws.includes(WS_ORIGIN_TOKEN)) {
      problems.push(`CSP: ${ORIGIN_TOKEN} was not rendered (run bun run render:headers)`);
    } else if (originOf(origin) !== origin) {
      problems.push(
        `CSP: connect-src origin must be an https origin without path or wildcard (found ${origin})`,
      );
    } else if (ws !== wsOriginOf(origin)) {
      problems.push(
        `CSP: connect-src websocket origin must be ${wsOriginOf(origin)} (found ${ws})`,
      );
    } else if (mode.expectedOrigin !== undefined && origin !== mode.expectedOrigin) {
      problems.push(
        `CSP: connect-src origin ${origin} differs from the expected ${mode.expectedOrigin}`,
      );
    }
  }
  for (const [name, sources] of csp) {
    if (!(name in EXACT) && !(name in SUBSET) && name !== "connect-src")
      problems.push(`CSP: unexpected directive ${name}`);
    for (const source of sources) {
      if (source.includes("*")) problems.push(`CSP: ${name} contains a wildcard (${source})`);
      if (source === "'unsafe-eval'") problems.push(`CSP: ${name} contains 'unsafe-eval'`);
      if (source === "'unsafe-inline'" && name !== "style-src")
        problems.push(`CSP: ${name} contains 'unsafe-inline'`);
    }
  }
  return problems;
}

export const DENIED_FEATURES = [
  "accelerometer",
  "autoplay",
  "bluetooth",
  "camera",
  "display-capture",
  "geolocation",
  "gyroscope",
  "hid",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "serial",
  "usb",
  "xr-spatial-tracking",
] as const;

export function permissionsProblems(value: string): string[] {
  const parsed = new Map<string, string>();
  for (const part of value.split(",")) {
    const match = /^\s*([a-z-]+)=\((.*)\)\s*$/.exec(part);
    if (match?.[1] !== undefined) parsed.set(match[1], (match[2] ?? "").trim());
    else if (part.trim() !== "") parsed.set(part.trim(), "*");
  }
  const problems: string[] = [];
  for (const feature of DENIED_FEATURES) {
    const v = parsed.get(feature);
    if (v === undefined) problems.push(`Permissions-Policy: ${feature} is not denied (missing)`);
    else if (v !== "") problems.push(`Permissions-Policy: ${feature} must be () (found ${v})`);
  }
  if (parsed.get("clipboard-write") !== "self")
    problems.push("Permissions-Policy: clipboard-write must be (self) (the Copy button)");
  for (const [feature, v] of parsed) {
    if (feature === "clipboard-write" || (DENIED_FEATURES as readonly string[]).includes(feature))
      continue;
    problems.push(`Permissions-Policy: ${feature}=(${v}) is not on the reviewed list`);
  }
  return problems;
}

export function headerProblems(rules: HeaderRules, mode: HeaderMode): string[] {
  const all = rules.get("/*");
  if (all === undefined) return ["/* rule is missing"];
  const problems: string[] = [];
  const enforced = all.get("content-security-policy");
  if (all.has("content-security-policy-report-only"))
    problems.push(
      "Content-Security-Policy-Report-Only must not be shipped (the policy is enforced)",
    );
  if (enforced === undefined) problems.push("Content-Security-Policy is missing");
  else problems.push(...cspProblems(enforced, mode));
  const expect = (name: string, value: string) => {
    if (all.get(name.toLowerCase()) !== value)
      problems.push(`${name} must be ${value} (found ${all.get(name.toLowerCase()) ?? "missing"})`);
  };
  expect("X-Frame-Options", "DENY");
  expect("X-Content-Type-Options", "nosniff");
  expect("Referrer-Policy", "strict-origin-when-cross-origin");
  expect("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  const permissions = all.get("permissions-policy");
  if (permissions === undefined) problems.push("Permissions-Policy is missing");
  else problems.push(...permissionsProblems(permissions));
  const hsts = all.get("strict-transport-security");
  if (hsts !== undefined) {
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? "0");
    if (maxAge < 15_552_000)
      problems.push(
        `Strict-Transport-Security max-age must be at least 15552000 (found ${maxAge})`,
      );
  }
  if (!(rules.get("/sw.js")?.get("cache-control") ?? "").includes("no-cache"))
    problems.push("/sw.js must be Cache-Control: no-cache");
  if (!(rules.get("/index.html")?.get("cache-control") ?? "").includes("no-cache"))
    problems.push("/index.html must be Cache-Control: no-cache");
  if (!(rules.get("/assets/*")?.get("cache-control") ?? "").includes("immutable"))
    problems.push("/assets/* must be immutable");
  return problems;
}
