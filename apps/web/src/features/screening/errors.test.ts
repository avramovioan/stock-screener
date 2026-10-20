import { describe, expect, it } from "vitest";
import { ApiError, describeApiError, errorText, toApiError } from "./errors";

describe("toApiError", () => {
  it("maps status 0 to network", () => {
    expect(toApiError({ status: 0, message: "TypeError: Failed to fetch" }).kind).toBe("network");
  });
  it("maps 429 to rate_limited", () => {
    expect(toApiError({ status: 429, message: "slow down" }).kind).toBe("rate_limited");
  });
  it("maps 401, 403 and Postgres 42501 to rls_denied", () => {
    expect(toApiError({ status: 401, message: "x" }).kind).toBe("rls_denied");
    expect(toApiError({ status: 403, message: "x" }).kind).toBe("rls_denied");
    expect(toApiError({ status: 400, code: "42501", message: "x" }).kind).toBe("rls_denied");
  });
  it("maps everything else to server and keeps the message", () => {
    const e = toApiError({ status: 500, message: "boom" });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("server");
    expect(e.message).toBe("boom");
  });
  it("has a human sentence per kind", () => {
    expect(describeApiError("network")).toMatch(/connection/i);
    expect(describeApiError("rate_limited")).toMatch(/too many/i);
    expect(describeApiError("rls_denied")).toMatch(/not allowed/i);
    expect(describeApiError("server")).toMatch(/something went wrong/i);
  });
});

describe("errorText", () => {
  it("describes any thrown value", () => {
    expect(errorText(new ApiError("network", "x"))).toMatch(/connection/i);
    expect(errorText(new Error("x"))).toMatch(/something went wrong/i);
  });
});
