import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHeaders } from "./headers.ts";
import { webBuildSupabaseUrl } from "./web-build-env.ts";

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "web-build-env-"));
  saved = process.env.VITE_SUPABASE_URL;
  delete process.env.VITE_SUPABASE_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.VITE_SUPABASE_URL;
  else process.env.VITE_SUPABASE_URL = saved;
  rmSync(dir, { recursive: true, force: true });
});
const put = (name: string, text: string) => writeFileSync(join(dir, name), text);

describe("webBuildSupabaseUrl", () => {
  it("is undefined when nothing defines it", () => {
    expect(webBuildSupabaseUrl(dir)).toBeUndefined();
  });
  it("reads .env.local", () => {
    put(".env.local", 'VITE_SUPABASE_URL="https://local.supabase.co"\n');
    expect(webBuildSupabaseUrl(dir)).toBe("https://local.supabase.co");
  });
  it("later files override earlier ones", () => {
    put(".env", "VITE_SUPABASE_URL=https://a.supabase.co\n");
    put(".env.local", "VITE_SUPABASE_URL=https://b.supabase.co\n");
    expect(webBuildSupabaseUrl(dir)).toBe("https://b.supabase.co");
    put(".env.production", "VITE_SUPABASE_URL=https://c.supabase.co\n");
    expect(webBuildSupabaseUrl(dir)).toBe("https://c.supabase.co");
    put(".env.production.local", "VITE_SUPABASE_URL=https://d.supabase.co\n");
    expect(webBuildSupabaseUrl(dir)).toBe("https://d.supabase.co");
  });
  it("process.env wins over every file", () => {
    put(".env.production.local", "VITE_SUPABASE_URL=https://d.supabase.co\n");
    process.env.VITE_SUPABASE_URL = "https://shell.supabase.co";
    expect(webBuildSupabaseUrl(dir)).toBe("https://shell.supabase.co");
  });
  it("renders a real origin when the URL only lives in .env.local", () => {
    mkdirSync(dir, { recursive: true });
    put(".env.local", "VITE_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\n");
    const template =
      "/*\n  Content-Security-Policy: connect-src 'self' __SUPABASE_ORIGIN__ __SUPABASE_WS_ORIGIN__\n";
    const out = renderHeaders(template, webBuildSupabaseUrl(dir));
    expect(out.placeholder).toBe(false);
    expect(out.text).toContain(
      "https://abcdefghijklmnopqrst.supabase.co wss://abcdefghijklmnopqrst.supabase.co",
    );
  });
});
