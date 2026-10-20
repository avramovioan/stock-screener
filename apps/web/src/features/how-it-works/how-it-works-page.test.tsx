import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signedOut } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";
import { renderWithProviders } from "@/test/render-with-providers";
import { HowItWorksPage } from "./how-it-works-page";

afterEach(cleanup);

describe("HowItWorksPage", () => {
  it("renders the title and the six section headings", async () => {
    renderWithProviders(<HowItWorksPage />, { path: "/how-it-works" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "How this screener works" }),
    ).toBeTruthy();
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual([
      "1. Which companies are watched",
      "2. The channel and the −3 line",
      "3. The daily scan",
      "4. AI research, on request",
      "5. Notifications",
      "6. Data and limits",
    ]);
  });
  it("states the settings-driven numbers", async () => {
    renderWithProviders(<HowItWorksPage />, { path: "/how-it-works" });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("US$50 billion")).toBeTruthy();
    expect(screen.getByText("72 hours")).toBeTruthy();
  });
  it("explains the −4 reach note, the AI buttons and the verdict tags", async () => {
    renderWithProviders(<HowItWorksPage />, { path: "/how-it-works" });
    await screen.findByRole("heading", { level: 1 });
    const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain(
      'Each card also says whether the price reached the −4 line ("Reached −4") or not yet ("Wait for −4").',
    );
    expect(text).toContain(
      "You can also run the same evaluation yourself: the ChatGPT, Claude, Grok and Gemini buttons copy the prompt and open that assistant, and the copy button just copies it.",
    );
    for (const tag of ["Strong buy", "Consider", "Unchecked", "Avoid"]) {
      expect(screen.getByText(tag, { selector: "strong" })).toBeTruthy();
    }
  });
  it("is reachable at /how-it-works and linked from the footer", async () => {
    await renderApp("/how-it-works", signedOut);
    expect(
      await screen.findByRole("heading", { level: 1, name: "How this screener works" }),
    ).toBeTruthy();
    const footer = await screen.findByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "How it works" }).getAttribute("href")).toBe(
      "/how-it-works",
    );
  });
});
