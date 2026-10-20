import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { type AuthErrorCode, type AuthErrorLike, mapAuthError } from "./errors";
import { providersOf } from "./identity";

// biome-ignore lint/suspicious/noExplicitAny: accepts both the typed app client and untyped test doubles
type AuthClient = Pick<SupabaseClient<any, any, any>, "auth" | "rpc" | "functions">;

export interface AuthFailure {
  ok: false;
  code: AuthErrorCode;
  message: string;
}
export type AuthResult<T> = { ok: true; data: T } | AuthFailure;
export type SignOutScope = "local" | "global" | "others";

export const AUDIT_EVENTS = {
  passwordChanged: "auth.password_changed",
  methodChanged: "auth.method_changed",
  signOutAll: "auth.sign_out_all",
} as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

/** What the invite list says about an e-mail address (Edge Function `account-access`). */
export type AccessStatus = "create_password" | "sign_in" | "not_possible";

const ACCESS_STATUSES: readonly AccessStatus[] = ["create_password", "sign_in", "not_possible"];

/** The `reason` values account-access answers with on a non-2xx status, as the error codes mapAuthError knows. */
const ACCESS_REASONS: Record<string, string> = {
  weak_password: "weak_password",
  not_possible: "not_possible",
  rate_limited: "over_request_rate_limit",
};

const OK: AuthResult<undefined> = { ok: true, data: undefined };

function failure(error: AuthErrorLike | null | undefined): AuthFailure {
  const mapped = mapAuthError(error);
  return { ok: false, code: mapped.code, message: mapped.message };
}

export function createAuthApi(client: AuthClient) {
  /** Writes an audit row through the RPC. Never throws; logs only the error code. */
  async function recordAudit(
    type: AuditEventType,
    meta: Record<string, unknown> = {},
  ): Promise<AuthResult<undefined>> {
    try {
      const { error } = await client.rpc("record_audit", { p_type: type, p_meta: meta });
      if (error) {
        console.warn("audit write failed", error.code);
        return failure(error);
      }
      return OK;
    } catch {
      console.warn("audit write failed", "exception");
      return failure(null);
    }
  }

  async function signInWithPassword(email: string, password: string): Promise<AuthResult<Session>> {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return failure(error ?? { code: "invalid_credentials" });
    return { ok: true, data: data.session };
  }

  /** Reads `{ reason }` from the body of a failed Edge Function call; any other failure is a network or unknown error. */
  async function accessFailure(error: unknown): Promise<AuthFailure> {
    const err = error as { name?: string; message?: string; context?: unknown } | null;
    const context = err?.context;
    if (context instanceof Response) {
      const body = (await context.json().catch(() => null)) as { reason?: unknown } | null;
      const code = typeof body?.reason === "string" ? ACCESS_REASONS[body.reason] : undefined;
      if (code) return failure({ code });
      if (context.status === 429) return failure({ code: "over_request_rate_limit" });
      return failure(null);
    }
    if (err?.name === "FunctionsFetchError" || err?.name === "FunctionsRelayError") {
      return failure({ name: "AuthRetryableFetchError" });
    }
    return failure(null);
  }

  /** Step 1 of sign-in: is this e-mail on the invite list, and does it still need a password? */
  async function checkAccess(email: string): Promise<AuthResult<AccessStatus>> {
    const { data, error } = await client.functions.invoke("account-access", {
      body: { action: "check", email },
    });
    if (error) return accessFailure(error);
    const status = (data as { status?: unknown } | null)?.status;
    const known = ACCESS_STATUSES.find((value) => value === status);
    return { ok: true, data: known ?? "not_possible" };
  }

  /** Sets the password of an invited e-mail (new account or pending reset), then signs in with it. */
  async function createPassword(email: string, password: string): Promise<AuthResult<Session>> {
    const { error } = await client.functions.invoke("account-access", {
      body: { action: "set_password", email, password },
    });
    if (error) return accessFailure(error);
    return signInWithPassword(email, password);
  }

  async function updatePassword(newPassword: string): Promise<AuthResult<undefined>> {
    const { data: current } = await client.auth.getSession();
    const before = providersOf(current.session?.user);
    const { data, error } = await client.auth.updateUser({ password: newPassword });
    if (error) return failure(error);
    await recordAudit(AUDIT_EVENTS.passwordChanged, { via: "profile" });
    const after = providersOf(data.user);
    if (before.join(",") !== after.join(",")) {
      await recordAudit(AUDIT_EVENTS.methodChanged, { from: before, to: after });
    }
    return OK;
  }

  /** Profile password change: verifies the current password first (spec 11.3), then updates. */
  async function changePassword(
    email: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthResult<undefined>> {
    const verified = await client.auth.signInWithPassword({ email, password: currentPassword });
    if (verified.error) {
      const failed = failure(verified.error);
      return failed.code === "invalid_credentials"
        ? { ok: false, code: "invalid_credentials", message: "The current password is incorrect." }
        : failed;
    }
    return updatePassword(newPassword);
  }

  async function signOut(scope: SignOutScope): Promise<AuthResult<undefined>> {
    if (scope !== "local") await recordAudit(AUDIT_EVENTS.signOutAll, { scope });
    const { error } = await client.auth.signOut({ scope });
    return error ? failure(error) : OK;
  }

  return {
    signInWithPassword,
    checkAccess,
    createPassword,
    updatePassword,
    changePassword,
    signOut,
    recordAudit,
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
