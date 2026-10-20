import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isNavigationFallbackAllowed, isNeverCached } from "./sw-routes";

const ORIGIN = "https://app.example.com";
const AUTH_PATHS = ["/auth/sign-in", "/auth/signed-out"];

describe("auth routes and the service worker", () => {
  it.each(AUTH_PATHS)("%s is excluded from the navigation fallback", (path) => {
    expect(
      isNavigationFallbackAllowed(new URL(`${ORIGIN}${path}?code=abc&next=%2Fportfolio`)),
    ).toBe(false);
  });

  it.each(AUTH_PATHS)("%s is never cached", (path) => {
    expect(isNeverCached(new URL(`${ORIGIN}${path}?code=abc`), new Headers(), ORIGIN)).toBe(true);
  });

  it("still allows the fallback for application routes", () => {
    for (const path of ["/", "/quotes", "/portfolio", "/profile/security", "/author"]) {
      expect(isNavigationFallbackAllowed(new URL(`${ORIGIN}${path}`))).toBe(true);
    }
  });
});

describe("public/_headers", () => {
  const text = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../public/_headers"),
    "utf8",
  );

  function rule(path: string): Map<string, string> {
    const out = new Map<string, string>();
    let active = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      if (!/^\s/.test(line)) {
        active = line.trim() === path;
        continue;
      }
      const colon = line.indexOf(":");
      if (active && colon > 0) {
        out.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
    }
    return out;
  }

  it("never lets the CDN or the browser cache the OAuth callback and the other auth pages", () => {
    expect(rule("/auth/*").get("cache-control")).toBe("no-store");
  });
});
