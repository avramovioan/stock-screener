import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkAuthConfig,
  PRODUCTION_SITE_PLACEHOLDER,
  parseToml,
  REQUIRED_PRODUCTION_PATHS,
} from "./auth-config.ts";

const VALID = `
project_id = "stock-screener"

[auth]
enabled = true
site_url = "http://localhost:5173" # local stack
additional_redirect_urls = [
  "http://localhost:5173/**",
  "http://127.0.0.1:5173/**",
  "https://screener.example.com/auth/callback",
  "https://screener.example.com/auth/update-password",
]
minimum_password_length = 10
password_requirements = "lower_upper_letters_digits"

[auth.email]
enable_confirmations = false

[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"
skip_nonce_check = false
`;

function without(text: string, line: string): string {
  expect(text).toContain(line);
  return text.replace(line, "");
}

function replaced(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe("parseToml", () => {
  it("reads sections, scalars, comments and multi-line arrays", () => {
    const sections = parseToml(VALID);
    expect(sections.get("auth")?.get("site_url")).toBe("http://localhost:5173");
    expect(sections.get("auth")?.get("minimum_password_length")).toBe(10);
    expect(sections.get("auth.email")?.get("enable_confirmations")).toBe(false);
    expect(sections.get("auth")?.get("additional_redirect_urls")).toEqual([
      "http://localhost:5173/**",
      "http://127.0.0.1:5173/**",
      "https://screener.example.com/auth/callback",
      "https://screener.example.com/auth/update-password",
    ]);
  });
});

describe("checkAuthConfig", () => {
  it("accepts the reference configuration", () => {
    expect(checkAuthConfig(VALID)).toEqual([]);
  });

  it("requires the production callback and update-password paths", () => {
    for (const path of REQUIRED_PRODUCTION_PATHS) {
      const broken = without(VALID, `  "${PRODUCTION_SITE_PLACEHOLDER}${path}",\n`);
      expect(checkAuthConfig(broken)).toContain(
        `redirect allow-list is missing ${PRODUCTION_SITE_PLACEHOLDER}${path}`,
      );
    }
  });

  it("checks a real production URL when one is given", () => {
    const problems = checkAuthConfig(VALID, { productionSiteUrl: "https://stocks.example.org/" });
    expect(problems).toContain(
      "redirect allow-list is missing https://stocks.example.org/auth/callback",
    );
  });

  it("rejects a wildcard host", () => {
    const broken = replaced(VALID, '"http://127.0.0.1:5173/**",', '"https://*.example.com/**",');
    const problems = checkAuthConfig(broken);
    expect(problems.some((p) => p.includes("wildcard in the host"))).toBe(true);
  });

  it("rejects a bare wildcard entry and a non-local wildcard path", () => {
    expect(
      checkAuthConfig(replaced(VALID, '"http://127.0.0.1:5173/**",', '"*",')).length,
    ).toBeGreaterThan(0);
    const wildcardPath = replaced(
      VALID,
      '"https://screener.example.com/auth/callback",',
      '"https://screener.example.com/**",',
    );
    expect(
      checkAuthConfig(wildcardPath).some((p) => p.includes("production entries are exact paths")),
    ).toBe(true);
  });

  it("rejects plain http for a non-local host", () => {
    const broken = replaced(
      VALID,
      '"https://screener.example.com/auth/callback",',
      '"http://screener.example.com/auth/callback",',
    );
    expect(checkAuthConfig(broken).some((p) => p.includes("must use https"))).toBe(true);
  });

  it("rejects userinfo in the authority", () => {
    const broken = replaced(
      VALID,
      '"http://127.0.0.1:5173/**",',
      '"https://localhost@evil.com/x",',
    );
    expect(checkAuthConfig(broken).some((p) => p.includes("userinfo"))).toBe(true);
  });

  it("rejects a foreign https host", () => {
    const broken = replaced(
      VALID,
      '"http://127.0.0.1:5173/**",',
      '"https://evil.example.net/auth/callback",',
    );
    expect(checkAuthConfig(broken).some((p) => p.includes("targets a host other than"))).toBe(true);
  });

  it("requires a local site_url", () => {
    const broken = replaced(
      VALID,
      'site_url = "http://localhost:5173"',
      'site_url = "https://screener.example.com"',
    );
    expect(checkAuthConfig(broken).some((p) => p.includes("site_url"))).toBe(true);
  });

  it("enforces the password policy", () => {
    expect(
      checkAuthConfig(
        replaced(VALID, "minimum_password_length = 10", "minimum_password_length = 6"),
      ),
    ).toContain("auth.minimum_password_length must be at least 10 (found 6)");
    expect(
      checkAuthConfig(
        replaced(
          VALID,
          'password_requirements = "lower_upper_letters_digits"',
          'password_requirements = ""',
        ),
      ).some((p) => p.includes("password_requirements")),
    ).toBe(true);
  });

  it("requires Google with env references, never literal secrets", () => {
    const literal = replaced(
      VALID,
      'secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"',
      'secret = "GOCSPX-literal-secret"',
    );
    expect(
      checkAuthConfig(literal).some((p) => p.includes("secret must be an env(NAME) reference")),
    ).toBe(true);
    expect(
      checkAuthConfig(replaced(VALID, "skip_nonce_check = false", "skip_nonce_check = true")),
    ).toContain("[auth.external.google] skip_nonce_check must be false");
    const disabled = replaced(
      VALID,
      "[auth.external.google]\nenabled = true",
      "[auth.external.google]\nenabled = false",
    );
    expect(checkAuthConfig(disabled)).toContain("[auth.external.google] enabled must be true");
    const missing = VALID.slice(0, VALID.indexOf("[auth.external.google]"));
    expect(checkAuthConfig(missing)).toContain("[auth.external.google] block is missing");
  });
});

describe("supabase/config.toml", () => {
  it("passes the auth configuration check", () => {
    const text = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
    expect(checkAuthConfig(text)).toEqual([]);
  });
});
