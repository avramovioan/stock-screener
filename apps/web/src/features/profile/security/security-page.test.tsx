import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { authApi } from "@/features/auth/default";
import { profileApi } from "@/features/profile/default";
import {
  bothUser,
  googleUser,
  makeIdentity,
  makeUser,
  passwordUser,
  signedIn,
} from "@/test/auth-fixtures";
import { fill, renderApp, submit } from "@/test/render-app";

const GOOGLE_EXPLANATION =
  "Your account signs in with Google; there is no password to change. Manage security in your Google account.";

beforeEach(() => {
  vi.mocked(profileApi.getProfile).mockResolvedValue({
    userId: "user-1",
    displayName: "Alice",
  });
});

describe("Security: email", () => {
  it("shows the email read-only with a Verified badge", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    expect(await screen.findByRole("heading", { level: 1, name: "Security" })).toBeTruthy();
    expect(screen.getByText("alice@example.test")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.queryByDisplayValue("alice@example.test")).toBeNull();
  });

  it("does not claim verification when the email is unconfirmed", async () => {
    const unconfirmed = makeUser({ ...passwordUser, email_confirmed_at: "" });
    await renderApp("/profile/security", signedIn(unconfirmed));
    expect(await screen.findByText("Not verified")).toBeTruthy();
    expect(screen.queryByText("Verified")).toBeNull();
  });
});

describe("Security: password branch", () => {
  it("shows the password form for an account with an email identity", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    expect(await screen.findByLabelText("Current password")).toBeTruthy();
    expect(screen.getByLabelText("New password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm new password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
    expect(screen.queryByText(GOOGLE_EXPLANATION)).toBeNull();
  });

  it("shows the form for an account that has both providers", async () => {
    await renderApp("/profile/security", signedIn(bothUser));
    expect(await screen.findByLabelText("New password")).toBeTruthy();
    expect(screen.queryByText(GOOGLE_EXPLANATION)).toBeNull();
  });

  it("validates before calling the API", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByLabelText("New password");
    submit("Change password");
    expect(await screen.findByText("Enter your current password.")).toBeTruthy();
    fill("Current password", "Old-Passw0rd-1");
    fill("New password", "New-Passw0rd-2");
    fill("Confirm new password", "New-Passw0rd-3");
    submit("Change password");
    expect(await screen.findByText("The passwords do not match.")).toBeTruthy();
    expect(authApi.changePassword).not.toHaveBeenCalled();
  });

  it("applies the one 12 to 72 character rule, with the same texts as sign-in", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByLabelText("New password");
    fill("Current password", "Old-Passw0rd-1");
    fill("New password", "short");
    fill("Confirm new password", "short");
    submit("Change password");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getAllByText("At least 12 characters.").length).toBeGreaterThan(1);
    expect(authApi.changePassword).not.toHaveBeenCalled();
  });

  it("changes the password, confirms and clears the fields", async () => {
    vi.mocked(authApi.changePassword).mockResolvedValue({ ok: true, data: undefined });
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByLabelText("New password");
    fill("Current password", "Old-Passw0rd-1");
    fill("New password", "New-Passw0rd-2");
    fill("Confirm new password", "New-Passw0rd-2");
    submit("Change password");
    await waitFor(() =>
      expect(authApi.changePassword).toHaveBeenCalledWith(
        "alice@example.test",
        "Old-Passw0rd-1",
        "New-Passw0rd-2",
      ),
    );
    expect(await screen.findByText("Password updated.")).toBeTruthy();
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  });

  it("shows the error when the current password is wrong", async () => {
    vi.mocked(authApi.changePassword).mockResolvedValue({
      ok: false,
      code: "invalid_credentials",
      message: "The current password is incorrect.",
    });
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByLabelText("New password");
    fill("Current password", "wrong");
    fill("New password", "New-Passw0rd-2");
    fill("Confirm new password", "New-Passw0rd-2");
    submit("Change password");
    expect(await screen.findByText("The current password is incorrect.")).toBeTruthy();
    expect(screen.queryByText("Password updated.")).toBeNull();
  });
});

describe("Security: Google-only branch", () => {
  it("explains instead of showing any password form", async () => {
    await renderApp("/profile/security", signedIn(googleUser));
    expect(await screen.findByText(GOOGLE_EXPLANATION)).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.queryByLabelText("Confirm new password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
    const link = screen.getByRole("link", { name: /google account security/i });
    expect(link.getAttribute("href")).toBe("https://myaccount.google.com/security");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("is not fooled by stale app_metadata that still lists email", async () => {
    const stale = makeUser({
      identities: [makeIdentity("google")],
      app_metadata: { provider: "google", providers: ["google", "email"] },
    });
    await renderApp("/profile/security", signedIn(stale));
    expect(await screen.findByText(GOOGLE_EXPLANATION)).toBeTruthy();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("shows neither form nor Google text when the providers are unknown", async () => {
    const unknown = makeUser({ identities: [], app_metadata: {} });
    await renderApp("/profile/security", signedIn(unknown));
    expect(
      await screen.findByText("Password changes are not available for this account."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.queryByText(GOOGLE_EXPLANATION)).toBeNull();
  });
});

describe("Security: providers and sessions", () => {
  it("lists the linked providers", async () => {
    await renderApp("/profile/security", signedIn(bothUser));
    const list = await screen.findByRole("list", { name: "Linked sign-in methods" });
    expect(within(list).getByText("Email and password")).toBeTruthy();
    expect(within(list).getByText("Google")).toBeTruthy();
  });

  it.each([
    ["password", passwordUser],
    ["Google-only", googleUser],
  ])(
    "offers sign out of all devices to a %s account, with a confirmation step",
    async (_name, user) => {
      vi.mocked(authApi.signOut).mockResolvedValue({ ok: true, data: undefined });
      const { router } = await renderApp("/profile/security", signedIn(user));
      fireEvent.click(await screen.findByRole("button", { name: "Sign out of all devices" }));
      expect(authApi.signOut).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Yes, sign out everywhere" }));
      await waitFor(() => expect(authApi.signOut).toHaveBeenCalledWith("global"));
      await waitFor(() => expect(router.state.location.pathname).toBe("/auth/signed-out"));
    },
  );

  it("stays on the page and shows the error when global sign-out fails", async () => {
    vi.mocked(authApi.signOut).mockResolvedValue({
      ok: false,
      code: "network",
      message: "Network problem. Try again.",
    });
    const { router } = await renderApp("/profile/security", signedIn(passwordUser));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out of all devices" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, sign out everywhere" }));
    await waitFor(() => expect(authApi.signOut).toHaveBeenCalledWith("global"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Network problem. Try again."));
    expect(router.state.location.pathname).toBe("/profile/security");
  });

  it("lets the user back out of the confirmation", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out of all devices" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Yes, sign out everywhere" })).toBeNull();
    expect(authApi.signOut).not.toHaveBeenCalled();
  });
});

describe("Security: display name", () => {
  it("loads, edits and saves the display name", async () => {
    vi.mocked(profileApi.updateDisplayName).mockResolvedValue(undefined);
    await renderApp("/profile/security", signedIn(passwordUser));
    expect(await screen.findByDisplayValue("Alice")).toBeTruthy();
    fill("Display name", "Alice B");
    submit("Save name");
    await waitFor(() =>
      expect(profileApi.updateDisplayName).toHaveBeenCalledWith("user-1", "Alice B"),
    );
    expect(await screen.findByText("Name saved.")).toBeTruthy();
  });

  it("validates the name before saving", async () => {
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByDisplayValue("Alice");
    fill("Display name", "   ");
    submit("Save name");
    expect(await screen.findByText("Enter a name.")).toBeTruthy();
    expect(profileApi.updateDisplayName).not.toHaveBeenCalled();
  });

  it("shows an error with a retry when the profile cannot be loaded", async () => {
    vi.mocked(profileApi.getProfile).mockRejectedValueOnce(
      new Error("Could not load your profile."),
    );
    await renderApp("/profile/security", signedIn(passwordUser));
    expect(await screen.findByText("Could not load your profile.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue("Alice")).toBeTruthy();
  });

  it("shows an error when saving fails", async () => {
    vi.mocked(profileApi.updateDisplayName).mockRejectedValue(
      new Error("Could not save your name."),
    );
    await renderApp("/profile/security", signedIn(passwordUser));
    await screen.findByDisplayValue("Alice");
    fill("Display name", "Alice C");
    submit("Save name");
    expect(await screen.findByText("Could not save your name.")).toBeTruthy();
  });
});
