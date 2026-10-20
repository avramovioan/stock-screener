import { describe, expect, it } from "vitest";
import { scanText } from "./secret-scan.ts";

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2lnbmF0dXJl`;

describe("scanText", () => {
  it("passes clean bundle text", () => {
    expect(scanText('const a = "hello"; fetch("/x");')).toEqual([]);
  });

  it("allows the public anon key (a JWT with role anon)", () => {
    const anon = jwt({ iss: "supabase", role: "anon", exp: 4102444800 });
    expect(scanText(`createClient("https://x.supabase.co","${anon}")`)).toEqual([]);
  });

  it("flags a service-role JWT", () => {
    const leaked = jwt({ iss: "supabase", role: "service_role", exp: 4102444800 });
    const findings = scanText(`const key="${leaked}"`);
    expect(findings.map((f) => f.rule)).toEqual(["service-role-jwt"]);
  });

  it("flags new-style secret API keys", () => {
    expect(scanText('k="sb_secret_abcdEFGH12345678"').map((f) => f.rule)).toEqual([
      "secret-api-key",
    ]);
    expect(scanText('k="sb_publishable_abcdEFGH12345678"')).toEqual([]);
  });

  it("flags server-only variable names that must never be bundled", () => {
    for (const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "CRON_SHARED_SECRET",
      "FLEX_ENC_KEY_V1",
      "VAPID_PRIVATE_KEY",
      "GEMINI_API_KEY",
    ]) {
      expect(scanText(`x = import.meta.env.${name}`).map((f) => f.detail)).toContain(name);
    }
  });

  it("does not flag the public VAPID key variable", () => {
    expect(scanText("import.meta.env.VITE_VAPID_PUBLIC_KEY")).toEqual([]);
  });
});
