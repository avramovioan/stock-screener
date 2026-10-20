import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: { error: vi.fn() },
}));

import { toast } from "sonner";
import { authApi } from "@/features/auth/default";
import { loading, signedIn, signedOut } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";

function header() {
  // Page headers inside <main> also count as banners in the DOM test library; the shell header is first.
  return within(screen.getAllByRole("banner")[0] as HTMLElement);
}

describe("user menu", () => {
  it("shows the Profile link and Sign out when signed in", async () => {
    await renderApp("/", signedIn());
    expect(header().getByRole("link", { name: "Profile" }).getAttribute("href")).toBe("/profile");
    expect(header().getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(header().queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("shows Sign in when signed out", async () => {
    await renderApp("/");
    expect(header().getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/auth/sign-in",
    );
    expect(header().queryByRole("link", { name: "Profile" })).toBeNull();
  });

  it("shows a placeholder, not Sign in or Profile, while loading", async () => {
    await renderApp("/", loading);
    expect(screen.getByTestId("user-menu-loading")).toBeTruthy();
    expect(header().queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(header().queryByRole("link", { name: "Profile" })).toBeNull();
  });

  it("navigates to the signed-out page and signs out locally", async () => {
    vi.mocked(authApi.signOut).mockResolvedValue({ ok: true, data: undefined });
    const { router } = await renderApp("/portfolio", signedIn());
    fireEvent.click(header().getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/signed-out"));
    expect(authApi.signOut).toHaveBeenCalledWith("local");
    expect(
      await screen.findByRole("heading", { level: 1, name: "You are signed out" }),
    ).toBeTruthy();
  });
});

describe("user menu sign-out failure", () => {
  it("signs out before navigating and stays put with an error when it fails", async () => {
    vi.mocked(authApi.signOut).mockResolvedValue({
      ok: false,
      code: "network",
      message: "Network problem. Try again.",
    });
    const { router } = await renderApp("/portfolio", signedIn());
    fireEvent.click(header().getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(authApi.signOut).toHaveBeenCalledWith("local"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Network problem. Try again."));
    expect(router.state.location.pathname).toBe("/portfolio");
  });

  it("does not bounce a protected page to sign-in while the sign-out is in flight", async () => {
    let finish: (value: { ok: true; data: undefined }) => void = () => undefined;
    vi.mocked(authApi.signOut).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { router, store } = await renderApp("/portfolio", signedIn());
    fireEvent.click(header().getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(authApi.signOut).toHaveBeenCalled());
    act(() => store.set(signedOut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.state.location.pathname).toBe("/portfolio");
    await act(async () => {
      finish({ ok: true, data: undefined });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/signed-out"));
  });
});
