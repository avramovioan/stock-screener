import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  createPasswordSchema,
  emailSchema,
  fieldErrors,
  PASSWORD_MIN_LENGTH_TEXT,
  passwordSchema,
  signInPasswordSchema,
} from "./schemas";

describe("passwordSchema", () => {
  it.each([["a".repeat(12)], ["correct horse battery"], ["a".repeat(72)]])(
    "accepts %s",
    (value) => {
      expect(passwordSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([["a".repeat(11)], ["a".repeat(73)]])("rejects %s", (value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });
});

describe("form schemas", () => {
  it("normalises the email", () => {
    expect(emailSchema.parse("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("does not apply a password policy on sign-in", () => {
    expect(signInPasswordSchema.safeParse("x").success).toBe(true);
    expect(signInPasswordSchema.safeParse("").success).toBe(false);
  });

  it("asks for 12 to 72 characters for a new invited password, any characters", () => {
    expect(
      createPasswordSchema.safeParse({ password: "a".repeat(12), confirm: "a".repeat(12) }).success,
    ).toBe(true);
    const short = createPasswordSchema.safeParse({ password: "a".repeat(11), confirm: "x" });
    expect(short.success).toBe(false);
    if (!short.success) expect(fieldErrors(short.error).password).toBe(PASSWORD_MIN_LENGTH_TEXT);
    expect(
      createPasswordSchema.safeParse({ password: "a".repeat(73), confirm: "a".repeat(73) }).success,
    ).toBe(false);
  });

  it("requires a matching confirmation for a new invited password", () => {
    const result = createPasswordSchema.safeParse({
      password: "a".repeat(12),
      confirm: "b".repeat(12),
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(fieldErrors(result.error).confirm).toBe("The passwords do not match.");
  });

  it("uses the same rule and error texts when changing the password in Profile", () => {
    const short = changePasswordSchema.safeParse({
      current: "x",
      password: "short",
      confirm: "short",
    });
    expect(short.success).toBe(false);
    if (!short.success) expect(fieldErrors(short.error).password).toBe(PASSWORD_MIN_LENGTH_TEXT);
    const long = "a".repeat(73);
    const tooLong = changePasswordSchema.safeParse({ current: "x", password: long, confirm: long });
    if (!tooLong.success)
      expect(fieldErrors(tooLong.error).password).toBe("At most 72 characters.");
    expect(tooLong.success).toBe(false);
    const ok = "all lower case works";
    expect(
      changePasswordSchema.safeParse({ current: "x", password: ok, confirm: ok }).success,
    ).toBe(true);
  });

  it("requires the current password when changing it", () => {
    const result = changePasswordSchema.safeParse({
      current: "",
      password: "a".repeat(12),
      confirm: "a".repeat(12),
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(fieldErrors(result.error).current).toBe("Enter your current password.");
  });
});
