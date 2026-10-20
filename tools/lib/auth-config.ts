/**
 * Static checks for the Supabase Auth section of supabase/config.toml (spec 11.1, 11.2).
 * The committed file describes the LOCAL stack; production values are set in the dashboard and
 * documented in docs/operator-guide.md section 3. The checks keep the allow-list free of wildcard
 * hosts, keep the production paths exact, and keep OAuth secrets out of the repository.
 */

export type TomlValue = string | number | boolean | string[];
export type TomlSections = Map<string, Map<string, TomlValue>>;

export const PRODUCTION_SITE_PLACEHOLDER = "https://screener.example.com";
export const REQUIRED_PRODUCTION_PATHS = ["/auth/callback", "/auth/update-password"] as const;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== "\\") inString = !inString;
    if (char === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw: string): TomlValue | undefined {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  return quoted ? (quoted[1] ?? "") : undefined;
}

function parseStringArray(raw: string): string[] {
  const values: string[] = [];
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)) values.push(match[1] ?? "");
  return values;
}

/** Minimal TOML reader: sections, scalars, string arrays (also multi-line), comments. */
export function parseToml(text: string): TomlSections {
  const sections: TomlSections = new Map([["", new Map()]]);
  let current = "";
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index] ?? "").trim();
    if (line === "") continue;
    const header = /^\[([^[\]]+)\]$/.exec(line);
    if (header) {
      current = (header[1] ?? "").trim();
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.startsWith("[")) {
      while (!/\]\s*$/.test(value) && index + 1 < lines.length) {
        index += 1;
        value += ` ${stripComment(lines[index] ?? "").trim()}`;
      }
      sections.get(current)?.set(key, parseStringArray(value));
      continue;
    }
    const scalar = parseScalar(value);
    if (scalar !== undefined) sections.get(current)?.set(key, scalar);
  }
  return sections;
}

function splitUrl(
  entry: string,
): { scheme: string; hostname: string; path: string; host: string } | null {
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/.exec(entry);
  if (!match) return null;
  const host = match[2] ?? "";
  return {
    scheme: match[1] ?? "",
    host,
    hostname: host.replace(/:\d+$/, ""),
    path: match[3] ?? "",
  };
}

export interface AuthConfigOptions {
  /** Production site origin that the allow-list must contain; defaults to the documented placeholder. */
  productionSiteUrl?: string;
}

export function checkAuthConfig(toml: string, options: AuthConfigOptions = {}): string[] {
  const sections = parseToml(toml);
  const auth = sections.get("auth");
  const problems: string[] = [];
  const base = (options.productionSiteUrl ?? PRODUCTION_SITE_PLACEHOLDER).replace(/\/+$/, "");

  const productionHost = splitUrl(base)?.host ?? "";

  const siteUrl = auth?.get("site_url");
  if (typeof siteUrl !== "string") {
    problems.push("auth.site_url is missing");
  } else {
    const parts = splitUrl(siteUrl);
    if (!parts || !LOCAL_HOSTNAMES.has(parts.hostname)) {
      problems.push(
        `auth.site_url must be a local http URL in the committed config (found ${siteUrl}); production uses the dashboard`,
      );
    }
  }

  const list = auth?.get("additional_redirect_urls");
  const entries = Array.isArray(list) ? list : [];
  if (entries.length === 0) problems.push("auth.additional_redirect_urls is empty");
  for (const entry of entries) {
    const parts = splitUrl(entry);
    if (!parts) {
      problems.push(`redirect url "${entry}" is not an absolute http(s) URL`);
      continue;
    }
    if (parts.host.includes("@")) {
      problems.push(`redirect url "${entry}" must not contain userinfo (@) in the authority`);
      continue;
    }
    if (parts.host.includes("*")) {
      problems.push(`redirect url "${entry}" has a wildcard in the host`);
      continue;
    }
    const local = LOCAL_HOSTNAMES.has(parts.hostname);
    if (!local && parts.host !== productionHost) {
      problems.push(
        `redirect url "${entry}" targets a host other than localhost, 127.0.0.1 or the production host ${productionHost}`,
      );
    }
    if (!local && parts.scheme !== "https") {
      problems.push(
        `redirect url "${entry}" must use https unless it targets localhost or 127.0.0.1`,
      );
    }
    if (!local && parts.path.includes("*")) {
      problems.push(
        `redirect url "${entry}" uses a wildcard path but is not local (production entries are exact paths)`,
      );
    }
  }
  for (const path of REQUIRED_PRODUCTION_PATHS) {
    if (!entries.includes(`${base}${path}`)) {
      problems.push(`redirect allow-list is missing ${base}${path}`);
    }
  }

  const minimum = auth?.get("minimum_password_length");
  if (typeof minimum !== "number" || minimum < 10) {
    problems.push(`auth.minimum_password_length must be at least 10 (found ${String(minimum)})`);
  }
  const requirements = auth?.get("password_requirements");
  if (typeof requirements !== "string" || requirements === "") {
    problems.push('auth.password_requirements must be set (use "lower_upper_letters_digits")');
  }

  if (typeof sections.get("auth.email")?.get("enable_confirmations") !== "boolean") {
    problems.push("[auth.email] enable_confirmations must be a boolean");
  }

  const google = sections.get("auth.external.google");
  if (!google) {
    problems.push("[auth.external.google] block is missing");
  } else {
    if (google.get("enabled") !== true)
      problems.push("[auth.external.google] enabled must be true");
    for (const key of ["client_id", "secret"] as const) {
      const value = google.get(key);
      if (typeof value !== "string" || !/^env\([A-Z][A-Z0-9_]*\)$/.test(value)) {
        problems.push(`[auth.external.google] ${key} must be an env(NAME) reference`);
      }
    }
    if (google.get("skip_nonce_check") !== false) {
      problems.push("[auth.external.google] skip_nonce_check must be false");
    }
  }
  return problems;
}
