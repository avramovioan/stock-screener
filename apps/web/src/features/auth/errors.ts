export type AuthErrorCode =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "rate_limited"
  | "email_rate_limited"
  | "weak_password"
  | "same_password"
  | "signup_disabled"
  | "captcha_failed"
  | "account_unavailable"
  | "callback_failed"
  | "not_possible"
  | "network"
  | "unknown";

export interface AuthErrorLike {
  message?: string | undefined;
  code?: string | undefined;
  status?: number | undefined;
  name?: string | undefined;
}

const MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: "Email or password is incorrect.",
  email_not_confirmed:
    "Your email address is not confirmed yet. Open the confirmation link we sent you, or ask for a new one.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  email_rate_limited: "Too many emails were requested. Wait before asking for another one.",
  weak_password: "The password does not meet the requirements.",
  same_password: "Choose a password that is different from the current one.",
  signup_disabled: "Sign-up is currently closed.",
  captcha_failed: "Verification failed. Reload the page and try again.",
  account_unavailable:
    "We could not create that account. If you have an account, sign in or reset your password.",
  callback_failed: "Sign-in could not be completed. Start again.",
  not_possible: "Not possible yet.",
  network: "Could not reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Try again.",
};

/** Maps a Supabase auth error to a fixed, user-facing message. Raw server text is never shown. */
export function mapAuthError(error: AuthErrorLike | null | undefined): {
  code: AuthErrorCode;
  message: string;
} {
  const code = (error?.code ?? "").toLowerCase();
  const text = (error?.message ?? "").toLowerCase();
  const pick = (value: AuthErrorCode) => ({ code: value, message: MESSAGES[value] });

  if (code === "invalid_credentials" || text.includes("invalid login credentials"))
    return pick("invalid_credentials");
  if (code === "email_not_confirmed" || text.includes("email not confirmed"))
    return pick("email_not_confirmed");
  if (code === "over_email_send_rate_limit" || text.includes("email rate limit"))
    return pick("email_rate_limited");
  if (code === "over_request_rate_limit" || error?.status === 429 || text.includes("rate limit")) {
    return pick("rate_limited");
  }
  if (code === "weak_password") return pick("weak_password");
  if (code === "same_password" || text.includes("different from the old password"))
    return pick("same_password");
  if (code === "signup_disabled") return pick("signup_disabled");
  if (code === "captcha_failed") return pick("captcha_failed");
  if (code === "user_already_exists") return pick("account_unavailable");
  if (code === "callback_failed") return pick("callback_failed");
  if (code === "not_possible") return pick("not_possible");
  if (
    error?.name === "AuthRetryableFetchError" ||
    text.includes("failed to fetch") ||
    text.includes("network")
  ) {
    return pick("network");
  }
  return pick("unknown");
}
