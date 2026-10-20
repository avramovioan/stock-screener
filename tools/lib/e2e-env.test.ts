import { describe, expect, it } from "vitest";
import {
  assertLocalStackUrl,
  invitedEmailRow,
  missingFunctionEnv,
  parseEnvFile,
  parseStackStatus,
  pushHost,
} from "./e2e-env.ts";

describe("invitedEmailRow", () => {
  it("lower-cases the e-mail and marks the e2e note without a reset", () => {
    expect(invitedEmailRow(" E2E-Owner@Example.Test ")).toEqual({
      email: "e2e-owner@example.test",
      reset_password: false,
      note: "e2e",
    });
  });
});

describe("parseStackStatus", () => {
  it("reads the legacy key names after status lines", () => {
    const out = `Stopped services: [x]\n${JSON.stringify({ API_URL: "http://127.0.0.1:54321", ANON_KEY: "a", SERVICE_ROLE_KEY: "s" })}\n`;
    expect(parseStackStatus(out)).toEqual({
      url: "http://127.0.0.1:54321",
      anonKey: "a",
      serviceKey: "s",
    });
  });
  it("falls back to the publishable and secret key names", () => {
    const out = JSON.stringify({
      API_URL: "http://127.0.0.1:54321",
      PUBLISHABLE_KEY: "p",
      SECRET_KEY: "k",
    });
    expect(parseStackStatus(out)).toMatchObject({ anonKey: "p", serviceKey: "k" });
  });
  it("fails loudly without JSON or keys", () => {
    expect(() => parseStackStatus("no json")).toThrow(/JSON/);
    expect(() => parseStackStatus(JSON.stringify({ API_URL: "x" }))).toThrow(/ANON_KEY/);
  });
});

describe("parseEnvFile", () => {
  it("reads quoted values and ignores comments and blank lines", () => {
    expect(parseEnvFile('# c\n\nA=1\nB=\'two words\'\nC="{\\"k\\":1}"\r\n')).toEqual({
      A: "1",
      B: "two words",
      C: '{\\"k\\":1}',
    });
  });
});

describe("missingFunctionEnv", () => {
  const ok = {
    CRON_SHARED_SECRET: "c",
    FLEX_ENC_KEY_V1: "k",
    RATE_LIMIT_SALT: "s",
    VAPID_PUBLIC_KEY: "p",
    VAPID_PRIVATE_KEY: "q",
    VAPID_SUBJECT: "mailto:x@example.test",
    PUSH_ENDPOINT_EXTRA_HOSTS: "push.example.test",
    ALLOW_FIXTURE_PROVIDERS: "1",
    FLEX_FIXTURE_MODE: "1",
  };
  it("accepts a complete file", () => {
    expect(missingFunctionEnv(ok)).toEqual([]);
  });
  it("names every missing value and wrong flag", () => {
    const problems = missingFunctionEnv({ ...ok, RATE_LIMIT_SALT: "", FLEX_FIXTURE_MODE: "0" });
    expect(problems).toEqual(["RATE_LIMIT_SALT is not set", "FLEX_FIXTURE_MODE must be 1"]);
  });
});

describe("pushHost", () => {
  it("takes the first extra host", () => {
    expect(pushHost({ PUSH_ENDPOINT_EXTRA_HOSTS: "a.test, b.test" })).toBe("a.test");
    expect(() => pushHost({})).toThrow(/PUSH_ENDPOINT_EXTRA_HOSTS/);
  });
});

describe("assertLocalStackUrl", () => {
  it("accepts the local stack and refuses everything else", () => {
    expect(() => assertLocalStackUrl("http://127.0.0.1:54321")).not.toThrow();
    expect(() => assertLocalStackUrl("http://localhost:54321")).not.toThrow();
    expect(() => assertLocalStackUrl("https://abc.supabase.co")).toThrow(/non-local/);
    expect(() => assertLocalStackUrl("http://127.0.0.1.evil.example")).toThrow(/non-local/);
    expect(() => assertLocalStackUrl("nonsense")).toThrow(/not a URL/);
  });
});

describe("jwtIssuerProblem", () => {
  it("accepts the local issuer and names the file and value otherwise", async () => {
    const { jwtIssuerProblem, assertLocalJwtIssuer, LOCAL_JWT_ISSUER } = await import(
      "./e2e-env.ts"
    );
    expect(jwtIssuerProblem({ JWT_ISSUER: LOCAL_JWT_ISSUER })).toBeUndefined();
    expect(jwtIssuerProblem({})).toMatch(
      /supabase\/functions\/\.env: JWT_ISSUER is not set.*http:\/\/127\.0\.0\.1:54321\/auth\/v1/,
    );
    expect(jwtIssuerProblem({ JWT_ISSUER: "https://x.supabase.co/auth/v1" })).toMatch(
      /is https:\/\/x\.supabase\.co/,
    );
    expect(() => assertLocalJwtIssuer(undefined)).toThrow(/JWT_ISSUER/);
    expect(() => assertLocalJwtIssuer(`JWT_ISSUER=${LOCAL_JWT_ISSUER}\n`)).not.toThrow();
  });
});
