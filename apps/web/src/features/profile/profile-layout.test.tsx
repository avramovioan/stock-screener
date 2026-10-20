import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileApi } from "@/features/profile/default";
import { signedIn, signedOut } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";

beforeEach(() => {
  vi.mocked(profileApi.getProfile).mockResolvedValue({
    userId: "user-1",
    displayName: null,
  });
});

describe("profile layout", () => {
  it("redirects /profile to /profile/security", async () => {
    const { router } = await renderApp("/profile", signedIn());
    expect(router.state.location.pathname).toBe("/profile/security");
  });

  it("renders a sub-navigation with Broker, Notifications and Security", async () => {
    await renderApp("/profile/security", signedIn());
    const nav = await screen.findByRole("navigation", { name: "Profile sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "Broker",
      "Notifications",
      "Security",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/profile/broker",
      "/profile/notifications",
      "/profile/security",
    ]);
  });

  it("marks only the current section as active", async () => {
    await renderApp("/profile/broker", signedIn());
    const nav = await screen.findByRole("navigation", { name: "Profile sections" });
    expect(within(nav).getByRole("link", { name: "Broker" }).getAttribute("data-status")).toBe(
      "active",
    );
    expect(
      within(nav).getByRole("link", { name: "Security" }).getAttribute("data-status"),
    ).not.toBe("active");
  });

  it("navigates between sections", async () => {
    const { router } = await renderApp("/profile/security", signedIn());
    const nav = await screen.findByRole("navigation", { name: "Profile sections" });
    fireEvent.click(within(nav).getByRole("link", { name: "Broker" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profile/broker"));
    expect(await screen.findByRole("heading", { level: 1, name: "Broker" })).toBeTruthy();
  });

  it("protects every child route", async () => {
    for (const section of ["security", "broker", "notifications"]) {
      const { router } = await renderApp(`/profile/${section}`, signedOut);
      expect(router.state.location.pathname).toBe("/auth/sign-in");
      expect(router.state.location.search).toEqual({ next: `/profile/${section}` });
    }
  });
});
