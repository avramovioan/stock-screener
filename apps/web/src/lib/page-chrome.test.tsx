import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { signedIn, signedOut } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";
import { titleForPath } from "./page-chrome";

describe("titleForPath", () => {
  it.each([
    ["/", "Overview · Stock Screener"],
    ["/quotes", "Quotes · Stock Screener"],
    ["/about", "About · Stock Screener"],
    ["/portfolio", "Portfolio · Stock Screener"],
    ["/analytics", "Analytics · Stock Screener"],
    ["/profile/security", "Security · Stock Screener"],
    ["/profile/broker", "Broker · Stock Screener"],
    ["/profile/notifications", "Notifications · Stock Screener"],
    ["/auth/sign-in", "Sign in · Stock Screener"],
    ["/auth/signed-out", "You are signed out · Stock Screener"],
    ["/research/abc-123", "Research report · Stock Screener"],
    ["/nope", "Page not found · Stock Screener"],
  ])("%s -> %s", (path, title) => {
    expect(titleForPath(path)).toBe(title);
  });
});

describe("page chrome on navigation", () => {
  it("sets the title on the initial load without moving focus", async () => {
    await renderApp("/quotes", signedOut);
    expect(document.title).toBe("Quotes · Stock Screener");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(document.body);
  });

  it("changes the title and focuses the heading after a navigation", async () => {
    const { router } = await renderApp("/", signedIn());
    await act(async () => {
      await router.navigate({ to: "/portfolio" });
    });
    await waitFor(() => expect(document.title).toBe("Portfolio · Stock Screener"));
    const heading = await screen.findByRole("heading", { level: 1, name: "Portfolio" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("focuses the auth page heading after navigating to sign-in", async () => {
    const { router } = await renderApp("/about", signedOut);
    await act(async () => {
      await router.navigate({ to: "/auth/sign-in" });
    });
    const heading = await screen.findByRole("heading", { level: 1, name: "Sign in" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.title).toBe("Sign in · Stock Screener");
  });
});
