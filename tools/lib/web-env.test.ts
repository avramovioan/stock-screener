import { describe, expect, it } from "vitest";
import { webEnvProblems } from "./web-env.ts";

const good = {
  VITE_SUPABASE_URL: "https://abcd1234.supabase.co",
  VITE_SUPABASE_ANON_KEY: "public-anon-key",
  VITE_SITE_URL: "https://screener.example.com",
};

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const serviceRoleJwt = `${b64url({ alg: "HS256" })}.${b64url({ role: "service_role" })}.c2lnbmF0dXJl`;

describe("webEnvProblems", () => {
  it("accepts a complete production configuration", () => {
    expect(webEnvProblems(good)).toEqual([]);
  });

  it.each(Object.keys(good))("flags an empty or missing %s", (name) => {
    expect(webEnvProblems({ ...good, [name]: "" })).toContain(`${name} is empty or not set`);
    const { [name]: _removed, ...rest } = good as Record<string, string>;
    expect(webEnvProblems(rest)).toContain(`${name} is empty or not set`);
  });

  it("rejects localhost and plain http URLs unless local builds are allowed", () => {
    const local = {
      ...good,
      VITE_SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_SITE_URL: "http://localhost:5173",
    };
    expect(webEnvProblems(local)).toEqual([
      "VITE_SUPABASE_URL points at a local address",
      "VITE_SUPABASE_URL must use https",
      "VITE_SITE_URL points at a local address",
      "VITE_SITE_URL must use https",
    ]);
    expect(webEnvProblems(local, { allowLocal: true })).toEqual([]);
  });

  it("rejects values that are not URLs", () => {
    expect(webEnvProblems({ ...good, VITE_SITE_URL: "screener.example.com" })).toContain(
      "VITE_SITE_URL is not a valid URL",
    );
  });

  it("rejects VITE_ variables named like secrets", () => {
    for (const name of [
      "VITE_SERVICE_ROLE_KEY",
      "VITE_GEMINI_API_KEY",
      "VITE_VAPID_PRIVATE_KEY",
      "VITE_ADMIN_TOKEN",
      "VITE_SOMETHING_API_KEY",
    ]) {
      expect(webEnvProblems({ ...good, [name]: "x" })).toContain(
        `${name} looks like a secret and would be embedded in the browser bundle`,
      );
    }
  });

  it("allows the public VAPID and Turnstile site keys", () => {
    expect(
      webEnvProblems({
        ...good,
        VITE_VAPID_PUBLIC_KEY: "BPublic",
        VITE_TURNSTILE_SITE_KEY: "0xAAAA",
      }),
    ).toEqual([]);
  });

  it("rejects a service-role JWT hidden in any VITE_ value", () => {
    expect(webEnvProblems({ ...good, VITE_SUPABASE_ANON_KEY: serviceRoleJwt })).toContain(
      "VITE_SUPABASE_ANON_KEY contains a service-role key",
    );
  });
});
