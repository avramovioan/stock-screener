import { describe, expect, it } from "vitest";
import { bothUser, googleUser, makeIdentity, makeUser, passwordUser } from "@/test/auth-fixtures";
import { hasPasswordIdentity, isGoogleOnly, providersOf } from "./identity";

describe("identity helpers", () => {
  it.each([
    ["password-only", passwordUser, ["email"], true, false],
    ["google-only", googleUser, ["google"], false, true],
    ["both providers", bothUser, ["email", "google"], true, false],
  ] as const)("%s", (_name, user, providers, hasPassword, googleOnly) => {
    expect(providersOf(user)).toEqual(providers);
    expect(hasPasswordIdentity(user)).toBe(hasPassword);
    expect(isGoogleOnly(user)).toBe(googleOnly);
  });

  it("treats identities as authoritative over stale app_metadata", () => {
    const stale = makeUser({
      identities: [makeIdentity("google")],
      app_metadata: { provider: "google", providers: ["google", "email"] },
    });
    expect(providersOf(stale)).toEqual(["google"]);
    expect(hasPasswordIdentity(stale)).toBe(false);
    expect(isGoogleOnly(stale)).toBe(true);
  });

  it("falls back to app_metadata.providers when identities are empty", () => {
    const fallback = makeUser({ identities: [], app_metadata: { providers: ["email"] } });
    expect(providersOf(fallback)).toEqual(["email"]);
    expect(hasPasswordIdentity(fallback)).toBe(true);
    expect(isGoogleOnly(fallback)).toBe(false);
  });

  it("is neither password nor Google-only when nothing is known", () => {
    const unknown = makeUser({ identities: [], app_metadata: {} });
    expect(providersOf(unknown)).toEqual([]);
    expect(hasPasswordIdentity(unknown)).toBe(false);
    expect(isGoogleOnly(unknown)).toBe(false);
  });

  it("handles a missing user", () => {
    expect(providersOf(null)).toEqual([]);
    expect(hasPasswordIdentity(undefined)).toBe(false);
    expect(isGoogleOnly(null)).toBe(false);
  });
});
