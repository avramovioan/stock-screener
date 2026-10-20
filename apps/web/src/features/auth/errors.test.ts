import { describe, expect, it } from "vitest";
import { mapAuthError } from "./errors";

describe("mapAuthError", () => {
  it.each([
    [
      { code: "invalid_credentials", message: "Invalid login credentials", status: 400 },
      "invalid_credentials",
    ],
    [{ message: "Invalid login credentials" }, "invalid_credentials"],
    [
      { code: "email_not_confirmed", message: "Email not confirmed", status: 400 },
      "email_not_confirmed",
    ],
    [
      { code: "over_request_rate_limit", message: "Request rate limit reached", status: 429 },
      "rate_limited",
    ],
    [{ status: 429, message: "Too many requests" }, "rate_limited"],
    [
      { code: "over_email_send_rate_limit", message: "email rate limit exceeded", status: 429 },
      "email_rate_limited",
    ],
    [{ code: "weak_password", message: "Password should contain letters" }, "weak_password"],
    [
      { code: "same_password", message: "New password should be different from the old password." },
      "same_password",
    ],
    [{ code: "signup_disabled", message: "Signups not allowed" }, "signup_disabled"],
    [{ code: "captcha_failed", message: "captcha verification process failed" }, "captcha_failed"],
    [{ code: "user_already_exists", message: "User already registered" }, "account_unavailable"],
    [{ name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 }, "network"],
    [{ code: "unexpected_failure", message: "boom" }, "unknown"],
  ])("maps %j to %s", (error, code) => {
    expect(mapAuthError(error).code).toBe(code);
  });

  it("maps null and undefined to unknown", () => {
    expect(mapAuthError(null).code).toBe("unknown");
    expect(mapAuthError(undefined).code).toBe("unknown");
  });

  it("gives user-facing messages that reveal nothing about account existence", () => {
    expect(mapAuthError({ code: "invalid_credentials" }).message).toBe(
      "Email or password is incorrect.",
    );
    expect(mapAuthError({ code: "user_already_exists" }).message).not.toMatch(
      /already (registered|exists)/i,
    );
    expect(mapAuthError({ code: "email_not_confirmed" }).message).toMatch(/confirm/i);
    expect(mapAuthError({ code: "over_request_rate_limit" }).message).toMatch(/too many/i);
  });

  it("never echoes the raw server message", () => {
    expect(
      mapAuthError({ code: "unexpected_failure", message: "secret internal detail" }).message,
    ).not.toMatch(/secret internal detail/);
  });
});
