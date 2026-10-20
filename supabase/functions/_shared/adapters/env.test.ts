import { assertEquals, assertThrows } from "@std/assert";
import { requireEnv, requireHttpsBase } from "./env.ts";

Deno.test("requireEnv returns a set variable", () => {
  Deno.env.set("P0_TEST_ENV", "value");
  try {
    assertEquals(requireEnv("P0_TEST_ENV"), "value");
  } finally {
    Deno.env.delete("P0_TEST_ENV");
  }
});

Deno.test("requireEnv throws for missing and blank variables", () => {
  Deno.env.delete("P0_TEST_MISSING");
  assertThrows(() => requireEnv("P0_TEST_MISSING"), Error, "P0_TEST_MISSING");
  Deno.env.set("P0_TEST_BLANK", "   ");
  try {
    assertThrows(() => requireEnv("P0_TEST_BLANK"), Error, "P0_TEST_BLANK");
  } finally {
    Deno.env.delete("P0_TEST_BLANK");
  }
});

Deno.test("requireHttpsBase accepts https, accepts http only for a local stack, rejects the rest", () => {
  assertEquals(
    requireHttpsBase("X_URL", "https://api.example.com/v1", "https://abc.supabase.co"),
    "https://api.example.com/v1",
  );
  assertEquals(
    requireHttpsBase("X_URL", "http://host.docker.internal:54782/mock", "http://127.0.0.1:54321"),
    "http://host.docker.internal:54782/mock",
  );
  assertEquals(
    requireHttpsBase("X_URL", "http://host.docker.internal:54782/mock", "http://kong:8000"),
    "http://host.docker.internal:54782/mock",
  );
  assertThrows(
    () => requireHttpsBase("X_URL", "http://api.example.com", "https://abc.supabase.co"),
    Error,
    "X_URL must be an https URL",
  );
  assertThrows(
    () => requireHttpsBase("X_URL", "ftp://api.example.com", "http://127.0.0.1:54321"),
    Error,
    "X_URL must be an https URL",
  );
  assertThrows(
    () => requireHttpsBase("X_URL", "not a url", "https://abc.supabase.co"),
    Error,
    "X_URL is not a valid URL",
  );
});
