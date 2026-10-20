import { describe, expect, it, vi } from "vitest";
import { bothUser, googleUser, makeSession, passwordUser } from "@/test/auth-fixtures";
import { AUDIT_EVENTS, createAuthApi } from "./api";

function makeClient() {
  const auth = {
    signInWithPassword: vi.fn(),
    updateUser: vi.fn(),
    getSession: vi.fn(),
    signOut: vi.fn(),
  };
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const functions = { invoke: vi.fn() };
  const client = { auth, rpc, functions } as unknown as Parameters<typeof createAuthApi>[0];
  return { auth, rpc, functions, api: createAuthApi(client) };
}

describe("signInWithPassword", () => {
  it("returns the session", async () => {
    const { auth, api } = makeClient();
    const session = makeSession(passwordUser);
    auth.signInWithPassword.mockResolvedValue({ data: { session }, error: null });
    expect(await api.signInWithPassword("a@b.co", "pw")).toEqual({ ok: true, data: session });
  });

  it("maps invalid credentials to the fixed message", async () => {
    const { auth, api } = makeClient();
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials", status: 400 },
    });
    expect(await api.signInWithPassword("a@b.co", "pw")).toEqual({
      ok: false,
      code: "invalid_credentials",
      message: "Email or password is incorrect.",
    });
  });
});

const httpError = (status: number, body: unknown) => ({
  name: "FunctionsHttpError",
  message: "Edge Function returned a non-2xx status code",
  context: new Response(JSON.stringify(body), { status }),
});

describe("checkAccess", () => {
  it("posts the e-mail to account-access and returns the status", async () => {
    const { functions, api } = makeClient();
    functions.invoke.mockResolvedValue({ data: { status: "create_password" }, error: null });
    expect(await api.checkAccess("a@b.co")).toEqual({ ok: true, data: "create_password" });
    expect(functions.invoke).toHaveBeenCalledWith("account-access", {
      body: { action: "check", email: "a@b.co" },
    });
  });

  it.each(["sign_in", "not_possible"])("passes %s through", async (status) => {
    const { functions, api } = makeClient();
    functions.invoke.mockResolvedValue({ data: { status }, error: null });
    expect(await api.checkAccess("a@b.co")).toEqual({ ok: true, data: status });
  });

  it("treats an unknown answer as not possible", async () => {
    const { functions, api } = makeClient();
    functions.invoke.mockResolvedValue({ data: { status: "who knows" }, error: null });
    expect(await api.checkAccess("a@b.co")).toEqual({ ok: true, data: "not_possible" });
  });

  it("maps a rate limit and a network failure to fixed messages", async () => {
    const { functions, api } = makeClient();
    functions.invoke.mockResolvedValueOnce({
      data: null,
      error: httpError(429, { ok: false, reason: "rate_limited", retry_after_seconds: 30 }),
    });
    expect(await api.checkAccess("a@b.co")).toMatchObject({ ok: false, code: "rate_limited" });
    functions.invoke.mockResolvedValueOnce({
      data: null,
      error: { name: "FunctionsFetchError", message: "Failed to send a request" },
    });
    expect(await api.checkAccess("a@b.co")).toMatchObject({ ok: false, code: "network" });
  });
});

describe("createPassword", () => {
  it("sets the password through account-access and then signs in with it", async () => {
    const { functions, auth, api } = makeClient();
    const session = makeSession(passwordUser);
    functions.invoke.mockResolvedValue({ data: { ok: true }, error: null });
    auth.signInWithPassword.mockResolvedValue({ data: { session }, error: null });
    expect(await api.createPassword("a@b.co", "correct horse battery")).toEqual({
      ok: true,
      data: session,
    });
    expect(functions.invoke).toHaveBeenCalledWith("account-access", {
      body: { action: "set_password", email: "a@b.co", password: "correct horse battery" },
    });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: "a@b.co",
      password: "correct horse battery",
    });
  });

  it.each([
    [400, "weak_password", "weak_password"],
    [403, "not_possible", "not_possible"],
    [429, "rate_limited", "rate_limited"],
  ])("maps the %i reason %s and never signs in", async (status, reason, code) => {
    const { functions, auth, api } = makeClient();
    functions.invoke.mockResolvedValue({
      data: null,
      error: httpError(status, { ok: false, reason }),
    });
    expect(await api.createPassword("a@b.co", "pw")).toMatchObject({ ok: false, code });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("falls back to an unknown failure for an unreadable error", async () => {
    const { functions, api } = makeClient();
    functions.invoke.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await api.createPassword("a@b.co", "pw")).toMatchObject({ ok: false, code: "unknown" });
  });
});

describe("updatePassword", () => {
  it("records the password change and no method change when providers are unchanged", async () => {
    const { auth, rpc, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: makeSession(passwordUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: passwordUser }, error: null });
    expect(await api.updatePassword("Abcdefghi1")).toEqual({
      ok: true,
      data: undefined,
    });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "Abcdefghi1" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_audit", {
      p_type: AUDIT_EVENTS.passwordChanged,
      p_meta: { via: "profile" },
    });
  });

  it("also records a sign-in method change when the provider set changes", async () => {
    const { auth, rpc, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: makeSession(googleUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: bothUser }, error: null });
    await api.updatePassword("Abcdefghi1");
    expect(rpc).toHaveBeenCalledWith("record_audit", {
      p_type: AUDIT_EVENTS.methodChanged,
      p_meta: { from: ["google"], to: ["email", "google"] },
    });
  });

  it("does not fail the update when the audit write fails", async () => {
    const { auth, rpc, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: makeSession(passwordUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: passwordUser }, error: null });
    rpc.mockResolvedValue({ error: { code: "54000", message: "audit rate limit reached" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await api.updatePassword("Abcdefghi1")).ok).toBe(true);
    expect(warn).toHaveBeenCalledWith("audit write failed", "54000");
    warn.mockRestore();
  });

  it("maps a rejected password", async () => {
    const { auth, rpc, api } = makeClient();
    auth.getSession.mockResolvedValue({ data: { session: makeSession(passwordUser) } });
    auth.updateUser.mockResolvedValue({
      data: { user: null },
      error: { code: "same_password", message: "x" },
    });
    const result = await api.updatePassword("Abcdefghi1");
    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("changePassword", () => {
  it("verifies the current password before updating", async () => {
    const { auth, api } = makeClient();
    auth.signInWithPassword.mockResolvedValue({
      data: { session: makeSession(passwordUser) },
      error: null,
    });
    auth.getSession.mockResolvedValue({ data: { session: makeSession(passwordUser) } });
    auth.updateUser.mockResolvedValue({ data: { user: passwordUser }, error: null });
    expect(
      (await api.changePassword("alice@example.test", "Old-Passw0rd-1", "New-Passw0rd-2")).ok,
    ).toBe(true);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: "alice@example.test",
      password: "Old-Passw0rd-1",
    });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "New-Passw0rd-2" });
  });

  it("stops with a clear message when the current password is wrong", async () => {
    const { auth, api } = makeClient();
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials", status: 400 },
    });
    const result = await api.changePassword("alice@example.test", "wrong", "New-Passw0rd-2");
    expect(result).toEqual({
      ok: false,
      code: "invalid_credentials",
      message: "The current password is incorrect.",
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("records sign-out-everywhere before calling signOut", async () => {
    const { auth, rpc, api } = makeClient();
    auth.signOut.mockResolvedValue({ error: null });
    expect((await api.signOut("global")).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("record_audit", {
      p_type: AUDIT_EVENTS.signOutAll,
      p_meta: { scope: "global" },
    });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
      auth.signOut.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not audit a local sign-out", async () => {
    const { auth, rpc, api } = makeClient();
    auth.signOut.mockResolvedValue({ error: null });
    await api.signOut("local");
    expect(rpc).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("recordAudit", () => {
  it("sends only the type and the metadata", async () => {
    const { rpc, api } = makeClient();
    await api.recordAudit(AUDIT_EVENTS.passwordChanged, { via: "profile" });
    expect(rpc).toHaveBeenCalledWith("record_audit", {
      p_type: "auth.password_changed",
      p_meta: { via: "profile" },
    });
  });
});
