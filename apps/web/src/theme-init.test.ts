import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// happy-dom replaces the global URL and mis-resolves file: URLs on Windows, so resolve paths with node:path
const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(here, "../public/theme-init.js"), "utf8");
const run = () => new Function(script)();
const isDark = () => document.documentElement.classList.contains("dark");

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("public/theme-init.js", () => {
  it("applies a stored dark theme", () => {
    window.localStorage.setItem("theme", "dark");
    run();
    expect(isDark()).toBe(true);
  });

  it("applies a stored light theme even when the system prefers dark", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    window.localStorage.setItem("theme", "light");
    run();
    expect(isDark()).toBe(false);
  });

  it("follows the system preference when nothing is stored", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    run();
    expect(isDark()).toBe(true);
  });

  it("does not throw when storage access throws", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
    });
    expect(run).not.toThrow();
    expect(isDark()).toBe(false);
  });
});
