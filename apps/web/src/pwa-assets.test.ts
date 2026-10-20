import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// fileURLToPath + node:path: happy-dom replaces the global URL and mangles file: URLs on Windows.
const here = dirname(fileURLToPath(import.meta.url));
const publicPath = (name: string) => resolve(here, "../public", name);
const readText = (name: string) => readFileSync(publicPath(name), "utf8");

function pngSize(name: string): { width: number; height: number } {
  const buffer = readFileSync(publicPath(name));
  expect(buffer.subarray(1, 4).toString("ascii"), `${name} is not a PNG`).toBe("PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

const manifest = JSON.parse(readText("manifest.webmanifest")) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
};

describe("web app manifest", () => {
  it("meets the installability checklist (spec 14.8)", () => {
    expect(manifest.name).toBe("Stock Screener");
    expect(manifest.short_name).toBe("Screener");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone"); // required for iOS Web Push
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("declares 192 and 512 icons plus a maskable icon whose files have the declared size", () => {
    const purposes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
    expect(purposes).toEqual(
      expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]),
    );
    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(pngSize(icon.src.replace(/^\//, ""))).toEqual({ width, height });
    }
  });

  it("ships a 180x180 apple-touch-icon referenced from index.html", () => {
    expect(pngSize("apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
    const html = readFileSync(resolve(here, "../index.html"), "utf8");
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="theme-color"');
  });
});

function parseHeaders(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const colon = line.indexOf(":");
    if (current && colon > 0) {
      current.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return rules;
}

describe("_headers", () => {
  const rules = parseHeaders(readText("_headers"));

  it("serves the service worker and manifest uncached from the site root", () => {
    expect(rules.get("/sw.js")?.get("cache-control")).toBe("no-cache");
    expect(rules.get("/sw.js")?.get("service-worker-allowed")).toBe("/");
    expect(rules.get("/manifest.webmanifest")?.get("cache-control")).toBe("no-cache");
    expect(rules.get("/index.html")?.get("cache-control")).toBe("no-cache");
  });

  it("sets basic security headers and an enforced CSP (P7: no report-only header)", () => {
    const all = rules.get("/*");
    expect(all?.get("x-content-type-options")).toBe("nosniff");
    expect(all?.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(all?.get("permissions-policy")).toContain("camera=()");
    expect(all?.has("content-security-policy-report-only")).toBe(false);
    expect(all?.has("content-security-policy")).toBe(true);
  });
});

describe("wrangler.jsonc", () => {
  const wranglerPath = resolve(here, "../wrangler.jsonc");
  // wrangler.jsonc carries whole-line // comments; drop them before parsing
  const config = JSON.parse(readFileSync(wranglerPath, "utf8").replace(/^\s*\/\/.*$/gm, "")) as {
    name: string;
    compatibility_date: string;
    workers_dev: boolean;
    preview_urls: boolean;
    assets: { directory: string; not_found_handling: string; html_handling: string };
  };

  it("serves ./dist as a single-page application without a Worker script", () => {
    expect(config.assets).toEqual({
      directory: "./dist",
      not_found_handling: "single-page-application",
      html_handling: "auto-trailing-slash",
    });
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(existsSync(wranglerPath)).toBe(true);
    expect("main" in config).toBe(false);
  });

  it("has one public address: workers.dev on, preview URLs off", () => {
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
  });
});
