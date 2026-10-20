import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createFakeAuthStore,
  loading,
  passwordUser,
  signedIn,
  signedOut,
} from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";
import { AuthProvider } from "./auth-provider";
import { AuthGate } from "./components/auth-gate";

describe("requireAuth", () => {
  it.each([
    ["/portfolio", "/portfolio"],
    ["/analytics", "/analytics"],
    ["/profile/security", "/profile/security"],
    ["/profile", "/profile"],
    ["/portfolio?tab=positions", "/portfolio?tab=positions"],
  ])("signed-out visit to %s goes to sign-in with next", async (path, next) => {
    const { router } = await renderApp(path, signedOut);
    expect(router.state.location.pathname).toBe("/auth/sign-in");
    expect(router.state.location.search).toEqual({ next });
  });

  it("serialises the target the way the e2e test expects", async () => {
    const { router } = await renderApp("/portfolio", signedOut);
    expect(router.state.location.href).toBe("/auth/sign-in?next=%2Fportfolio");
  });

  it("lets a signed-in user through", async () => {
    const { router } = await renderApp("/portfolio", signedIn());
    expect(router.state.location.pathname).toBe("/portfolio");
    expect(await screen.findByRole("heading", { level: 1, name: "Portfolio" })).toBeTruthy();
  });

  it("keeps public routes open", async () => {
    for (const path of ["/", "/quotes", "/about", "/auth/sign-in"]) {
      const { router } = await renderApp(path, signedOut);
      expect(router.state.location.pathname).toBe(path);
    }
  });

  it("renders a skeleton and no protected content while auth state is loading", async () => {
    const { router } = await renderApp("/portfolio", loading);
    expect(router.state.location.pathname).toBe("/portfolio");
    expect(screen.getByTestId("auth-skeleton")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Portfolio" })).toBeNull();
  });

  it("redirects when loading resolves to signed-out", async () => {
    const { router, store } = await renderApp("/portfolio", loading);
    act(() => store.set(signedOut));
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/sign-in"));
    expect(router.state.location.search).toEqual({ next: "/portfolio" });
    expect(screen.queryByRole("heading", { name: "Portfolio" })).toBeNull();
  });

  it("shows the page when loading resolves to signed-in", async () => {
    const { store } = await renderApp("/portfolio", loading);
    act(() => store.set(signedIn()));
    expect(await screen.findByRole("heading", { level: 1, name: "Portfolio" })).toBeTruthy();
    expect(screen.queryByTestId("auth-skeleton")).toBeNull();
  });

  it("sends a signed-out transition on a protected page to sign-in", async () => {
    const { router, store } = await renderApp("/analytics", signedIn());
    act(() => store.set(signedOut));
    await waitFor(() => expect(router.state.location.pathname).toBe("/auth/sign-in"));
    expect(router.state.location.search).toEqual({ next: "/analytics" });
  });
});

describe("AuthGate", () => {
  function renderGate(state: Parameters<typeof createFakeAuthStore>[0]) {
    const store = createFakeAuthStore(state);
    render(
      <AuthProvider store={store}>
        <AuthGate>
          <p>protected content</p>
        </AuthGate>
      </AuthProvider>,
    );
  }

  it.each([
    ["loading", loading],
    ["signed-out", signedOut],
    ["recovery session", signedIn(passwordUser, { recovery: true })],
  ])("never renders its children while %s", (_name, state) => {
    renderGate(state);
    expect(screen.queryByText("protected content")).toBeNull();
    expect(screen.getByTestId("auth-skeleton")).toBeTruthy();
  });

  it("renders its children for a signed-in user", () => {
    renderGate(signedIn());
    expect(screen.getByText("protected content")).toBeTruthy();
  });
});
