import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authApi } from "@/features/auth/default";
import { makeSession, passwordUser, signedIn } from "@/test/auth-fixtures";
import { fill, renderApp, submit } from "@/test/render-app";

const access = (status: "create_password" | "sign_in" | "not_possible") =>
  vi.mocked(authApi.checkAccess).mockResolvedValue({ ok: true, data: status });

function continueWith(email: string) {
  fill("E-mail", email);
  submit("Continue");
}

describe("sign-in, step 1", () => {
  it("asks for the e-mail only, with no sign-up, reset or Google way in", async () => {
    await renderApp("/auth/sign-in");
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(screen.getByLabelText("E-mail")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /google/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /create an account|forgot/i })).toBeNull();
  });

  it("shows a field error and does not call the API for an invalid e-mail", async () => {
    await renderApp("/auth/sign-in");
    continueWith("not-an-email");
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(authApi.checkAccess).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("E-mail")));
  });

  it("sends the trimmed lower-case e-mail to the list check", async () => {
    access("sign_in");
    await renderApp("/auth/sign-in");
    continueWith("  Friend@Example.com ");
    await waitFor(() => expect(authApi.checkAccess).toHaveBeenCalledWith("friend@example.com"));
  });

  it("shows the failure of the check and stays on step 1", async () => {
    vi.mocked(authApi.checkAccess).mockResolvedValue({
      ok: false,
      code: "network",
      message: "Could not reach the server. Check your connection and try again.",
    });
    await renderApp("/auth/sign-in");
    continueWith("friend@example.com");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not reach the server");
    expect(screen.getByLabelText("E-mail")).toBeTruthy();
  });
});

describe("sign-in, on the list without a password", () => {
  async function toCreate() {
    access("create_password");
    const app = await renderApp("/auth/sign-in?next=%2Fportfolio");
    continueWith("friend@example.com");
    await screen.findByRole("heading", { level: 1, name: "Create your password" });
    return app;
  }

  it("shows the Create your password step with the e-mail, Change and the 12 character hint", async () => {
    await toCreate();
    expect(screen.getByText("friend@example.com", { exact: false })).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm password")).toBeTruthy();
    expect(screen.getByText("At least 12 characters.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create password and sign in" })).toBeTruthy();
  });

  it("Change goes back to step 1 with the e-mail kept", async () => {
    await toCreate();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByLabelText("E-mail")).toBeTruthy();
    expect((screen.getByLabelText("E-mail") as HTMLInputElement).value).toBe("friend@example.com");
  });

  it("rejects a short password and a mismatch before calling the API", async () => {
    await toCreate();
    fill("Password", "short");
    fill("Confirm password", "short");
    submit("Create password and sign in");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getAllByText("At least 12 characters.").length).toBeGreaterThan(1);
    fill("Password", "twelve chars!");
    fill("Confirm password", "twelve chars?");
    submit("Create password and sign in");
    expect(await screen.findByText("The passwords do not match.")).toBeTruthy();
    expect(authApi.createPassword).not.toHaveBeenCalled();
  });

  it("creates the password, signs in and follows a validated next target", async () => {
    vi.mocked(authApi.createPassword).mockResolvedValue({
      ok: true,
      data: makeSession(passwordUser),
    });
    const { router, store } = await toCreate();
    fill("Password", "twelve chars!");
    fill("Confirm password", "twelve chars!");
    submit("Create password and sign in");
    await waitFor(() =>
      expect(authApi.createPassword).toHaveBeenCalledWith("friend@example.com", "twelve chars!"),
    );
    act(() => store.set(signedIn()));
    await waitFor(() => expect(router.state.location.pathname).toBe("/portfolio"));
  });

  it("falls back to Not possible yet when the server refuses", async () => {
    vi.mocked(authApi.createPassword).mockResolvedValue({
      ok: false,
      code: "not_possible",
      message: "Not possible yet.",
    });
    await toCreate();
    fill("Password", "twelve chars!");
    fill("Confirm password", "twelve chars!");
    submit("Create password and sign in");
    expect(await screen.findByRole("heading", { level: 1, name: "Not possible yet" })).toBeTruthy();
  });

  it("shows other failures in an alert and focuses it", async () => {
    vi.mocked(authApi.createPassword).mockResolvedValue({
      ok: false,
      code: "rate_limited",
      message: "Too many attempts. Wait a few minutes and try again.",
    });
    await toCreate();
    fill("Password", "twelve chars!");
    fill("Confirm password", "twelve chars!");
    submit("Create password and sign in");
    const alert = await screen.findByText("Too many attempts. Wait a few minutes and try again.");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe("sign-in, on the list with a password", () => {
  async function toWelcome() {
    access("sign_in");
    const app = await renderApp("/auth/sign-in?next=%2Fportfolio");
    continueWith("friend@example.com");
    await screen.findByRole("heading", { level: 1, name: "Welcome back" });
    return app;
  }

  it("shows Welcome back with the forgotten-password note", async () => {
    await toWelcome();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
    expect(screen.getByText("Forgot it? Ask the person who invited you to reset it.")).toBeTruthy();
  });

  it("signs in and then follows a validated next target", async () => {
    vi.mocked(authApi.signInWithPassword).mockResolvedValue({
      ok: true,
      data: makeSession(passwordUser),
    });
    const { router, store } = await toWelcome();
    fill("Password", "whatever");
    submit("Sign in");
    await waitFor(() =>
      expect(authApi.signInWithPassword).toHaveBeenCalledWith("friend@example.com", "whatever"),
    );
    act(() => store.set(signedIn()));
    await waitFor(() => expect(router.state.location.pathname).toBe("/portfolio"));
  });

  it("asks for the password before calling the API", async () => {
    await toWelcome();
    submit("Sign in");
    expect(await screen.findByText("Enter your password.")).toBeTruthy();
    expect(authApi.signInWithPassword).not.toHaveBeenCalled();
  });

  it("shows the mapped error and focuses it", async () => {
    vi.mocked(authApi.signInWithPassword).mockResolvedValue({
      ok: false,
      code: "invalid_credentials",
      message: "Email or password is incorrect.",
    });
    await toWelcome();
    fill("Password", "nope");
    submit("Sign in");
    const alert = await screen.findByText("Email or password is incorrect.");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe("sign-in, not on the list", () => {
  it("says only Not possible yet, with the e-mail and Change", async () => {
    access("not_possible");
    await renderApp("/auth/sign-in");
    continueWith("stranger@example.com");
    expect(await screen.findByRole("heading", { level: 1, name: "Not possible yet" })).toBeTruthy();
    expect(screen.getByText("stranger@example.com", { exact: false })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByLabelText("E-mail")).toBeTruthy();
  });
});

describe("sign-in redirects", () => {
  it.each([
    ["https%3A%2F%2Fevil.com"],
    ["%2F%2Fevil.com"],
    ["%2F%5Cevil.com"],
    ["javascript%3Aalert(1)"],
  ])("never leaves the app for the hostile next %s", async (hostile) => {
    const { router, store } = await renderApp(`/auth/sign-in?next=${hostile}`);
    act(() => store.set(signedIn()));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(window.location.hostname).not.toMatch(/evil/);
  });

  it("redirects an already signed-in visitor to the target", async () => {
    const { router } = await renderApp("/auth/sign-in?next=%2Fprofile%2Fsecurity", signedIn());
    await waitFor(() => expect(router.state.location.pathname).toBe("/profile/security"));
  });
});
