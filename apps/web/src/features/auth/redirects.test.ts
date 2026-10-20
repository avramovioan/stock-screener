import { describe, expect, it } from "vitest";
import { nextSearch, safeNext } from "./redirects";

describe("safeNext", () => {
  it.each([
    ["/portfolio", "/portfolio"],
    ["/portfolio?tab=positions#top", "/portfolio?tab=positions#top"],
    ["/profile/security", "/profile/security"],
    ["/quotes?symbol=MSFT", "/quotes?symbol=MSFT"],
    ["/", "/"],
  ])("accepts the internal path %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  it.each([
    ["//evil.com"],
    ["//evil.com/path"],
    ["https://evil"],
    ["https://evil.com/portfolio"],
    ["http://localhost:5173/portfolio"],
    ["/\\evil"],
    ["\\\\evil"],
    ["/\\/evil.com"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["/%2F/evil.com"],
    ["/..//evil.com"],
    ["/.//evil.com"],
    ["/a/..//evil.com"],
    ["/%2e%2e//evil.com"],
    ["/%2F%2Fevil.com"],
    ["/\\evil.com"],
    ["/%5Cevil.com"],
    ["/\t/evil.com"],
    ["/\n/evil.com"],
    [" /portfolio"],
    ["portfolio"],
    [""],
    ["/%E0%A4%A"],
    [`/${"a".repeat(600)}`],
  ])("rejects %j", (raw) => {
    expect(safeNext(raw)).toBe("/");
  });

  it("returns / for undefined and null", () => {
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(null)).toBe("/");
  });

  it("never sends the user back into an auth page", () => {
    expect(safeNext("/auth/sign-in")).toBe("/");
    expect(safeNext("/auth/sign-up?next=/portfolio")).toBe("/");
    expect(safeNext("/author")).toBe("/author");
  });
});

describe("nextSearch", () => {
  it("omits the default target", () => {
    expect(nextSearch("/")).toEqual({});
    expect(nextSearch("/portfolio")).toEqual({ next: "/portfolio" });
  });
});
