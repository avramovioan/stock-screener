import { describe, expect, it } from "vitest";
import {
  isNavigationFallbackAllowed,
  isNeverCached,
  parsePushPayload,
  resolveNotificationUrl,
} from "./sw-routes";

const ORIGIN = "https://screener.example.com";
const never = (url: string, headers: Record<string, string> = {}) =>
  isNeverCached(new URL(url), new Headers(headers), ORIGIN);

describe("isNeverCached", () => {
  it("never caches Supabase hosts", () => {
    expect(never("https://abcd1234.supabase.co/rest/v1/profiles")).toBe(true);
    expect(never("https://abcd1234.supabase.co/auth/v1/token?grant_type=password")).toBe(true);
    expect(never("https://abcd1234.supabase.co/functions/v1/health")).toBe(true);
    expect(never("https://supabase.co/")).toBe(true);
  });

  it("does not treat look-alike hosts as Supabase", () => {
    expect(never("https://evilsupabase.co/x.js")).toBe(false);
    expect(never("https://supabase.co.evil.example/x.js")).toBe(false);
  });

  it("never caches same-origin /rest, /auth and /functions paths", () => {
    expect(never(`${ORIGIN}/rest/v1/x`)).toBe(true);
    expect(never(`${ORIGIN}/auth/callback?code=abc`)).toBe(true);
    expect(never(`${ORIGIN}/functions/v1/quotes`)).toBe(true);
    expect(never(`${ORIGIN}/auth`)).toBe(true);
  });

  it("never caches requests carrying credentials headers", () => {
    expect(never("https://api.example.com/x", { Authorization: "Bearer t" })).toBe(true);
    expect(never("https://api.example.com/x", { apikey: "k" })).toBe(true);
  });

  it("leaves static assets to the precache", () => {
    expect(never(`${ORIGIN}/assets/index-abc.js`)).toBe(false);
    expect(never(`${ORIGIN}/authors`)).toBe(false);
    expect(never(`${ORIGIN}/quotes`)).toBe(false);
  });

  it("does not apply the path rule to other origins", () => {
    expect(never("https://cdn.example.com/auth/logo.png")).toBe(false);
  });
});

describe("isNavigationFallbackAllowed", () => {
  it("serves the SPA shell for application routes", () => {
    for (const path of ["/", "/quotes", "/portfolio", "/profile/security", "/about"]) {
      expect(isNavigationFallbackAllowed(new URL(path, ORIGIN))).toBe(true);
    }
  });

  it("does not swallow auth callbacks or function and REST paths", () => {
    for (const path of ["/auth/callback", "/auth/reset", "/functions/v1/x", "/rest/v1/x"]) {
      expect(isNavigationFallbackAllowed(new URL(path, ORIGIN))).toBe(false);
    }
  });
});

describe("parsePushPayload", () => {
  it("reads title, body and url from JSON", () => {
    expect(
      parsePushPayload('{"title":"Alert","body":"AAPL discounted","url":"/quotes?symbol=AAPL"}'),
    ).toEqual({
      title: "Alert",
      body: "AAPL discounted",
      url: "/quotes?symbol=AAPL",
    });
  });

  it("always yields something to show (iOS requires a notification per push)", () => {
    const fallback = { title: "Stock Screener", body: "There is something new.", url: "/" };
    expect(parsePushPayload("")).toEqual(fallback);
    expect(parsePushPayload("   ")).toEqual(fallback);
    expect(parsePushPayload("{}")).toEqual(fallback);
    expect(parsePushPayload('{"title":42,"body":null}')).toEqual(fallback);
  });

  it("treats non-JSON text as the body", () => {
    expect(parsePushPayload("plain text")).toEqual({
      title: "Stock Screener",
      body: "plain text",
      url: "/",
    });
  });

  it("clips oversized fields", () => {
    const payload = parsePushPayload(
      JSON.stringify({ title: "t".repeat(500), body: "b".repeat(900) }),
    );
    expect(payload.title.length).toBe(100);
    expect(payload.body.length).toBe(300);
  });

  it("keeps a short tag so a newer digest replaces the older notification, and omits it otherwise", () => {
    expect(parsePushPayload('{"title":"t","body":"b","url":"/","tag":"digest-discounts"}')).toEqual(
      {
        title: "t",
        body: "b",
        url: "/",
        tag: "digest-discounts",
      },
    );
    expect("tag" in parsePushPayload('{"title":"t","body":"b"}')).toBe(false);
    expect("tag" in parsePushPayload('{"tag":42}')).toBe(false);
    expect(parsePushPayload(JSON.stringify({ tag: "x".repeat(200) })).tag?.length).toBe(64);
  });
});

describe("resolveNotificationUrl", () => {
  it("keeps same-origin paths, queries and hashes", () => {
    expect(resolveNotificationUrl("/quotes?symbol=AAPL#chart", ORIGIN)).toBe(
      "/quotes?symbol=AAPL#chart",
    );
    expect(resolveNotificationUrl(`${ORIGIN}/portfolio`, ORIGIN)).toBe("/portfolio");
    expect(resolveNotificationUrl("portfolio", ORIGIN)).toBe("/portfolio");
  });

  it("refuses off-origin and non-http targets", () => {
    expect(resolveNotificationUrl("https://evil.example/x", ORIGIN)).toBe("/");
    expect(resolveNotificationUrl("//evil.example/x", ORIGIN)).toBe("/");
    expect(resolveNotificationUrl("javascript:alert(1)", ORIGIN)).toBe("/");
  });

  it("falls back to the home page for missing or invalid input", () => {
    expect(resolveNotificationUrl(undefined, ORIGIN)).toBe("/");
    expect(resolveNotificationUrl(42, ORIGIN)).toBe("/");
    expect(resolveNotificationUrl("", ORIGIN)).toBe("/");
  });
});
