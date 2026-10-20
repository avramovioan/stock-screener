import { afterAll, describe, expect, it } from "vitest";
import { createSupabaseClient } from "./supabase";
import source from "./supabase.ts?raw";

interface AuthInternals {
  flowType: string;
  detectSessionInUrl: boolean;
  persistSession: boolean;
  autoRefreshToken: boolean;
}

describe("createSupabaseClient", () => {
  const client = createSupabaseClient("http://127.0.0.1:54321", "anon-test-key");
  const auth = client.auth as unknown as AuthInternals;

  afterAll(async () => {
    await client.auth.stopAutoRefresh();
  });

  it("uses the PKCE flow with session detection, persistence and refresh", () => {
    expect(auth.flowType).toBe("pkce");
    expect(auth.detectSessionInUrl).toBe(true);
    expect(auth.persistSession).toBe(true);
    expect(auth.autoRefreshToken).toBe(true);
  });

  it("never references a service-role key in the browser client source", () => {
    expect(source).not.toMatch(/service[_-]?role|sb_secret_/i);
  });
});
