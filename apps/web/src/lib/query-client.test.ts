import { describe, expect, it } from "vitest";
import { ApiError } from "@/features/screening/errors";
import { shouldRetry } from "./query-client";

describe("shouldRetry", () => {
  it("never retries a denied or rate-limited request", () => {
    expect(shouldRetry(0, new ApiError("rls_denied", "no", 403))).toBe(false);
    expect(shouldRetry(0, new ApiError("rate_limited", "slow", 429))).toBe(false);
  });
  it("retries transient failures twice", () => {
    expect(shouldRetry(0, new ApiError("network", "x", 0))).toBe(true);
    expect(shouldRetry(1, new ApiError("server", "x", 500))).toBe(true);
    expect(shouldRetry(2, new ApiError("server", "x", 500))).toBe(false);
    expect(shouldRetry(0, new Error("unknown"))).toBe(true);
  });
});
