import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDiscount } from "@/test/fixtures";

interface ToastOptions {
  description?: string;
  duration?: number;
  action: { label: string; onClick: () => void };
}
const toasts = vi.hoisted(() => ({
  success: vi.fn<(message: string, options?: ToastOptions) => void>(),
  error: vi.fn<(message: string, options?: ToastOptions) => void>(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

import { AiHandoff, ASSISTANTS } from "./ai-handoff";
import { buildResearchPrompt } from "./research-prompt";

const row = makeDiscount({ name: "McDonald's Corporation", yahoo_symbol: "MCD" });
const writeText = vi.fn();
const open = vi.fn();
const GEMINI = "https://gemini.google.com/app";

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  open.mockReset();
  toasts.success.mockReset();
  toasts.error.mockReset();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.stubGlobal("open", open);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("AiHandoff", () => {
  it("has exactly the four configured assistants and modes", () => {
    expect(ASSISTANTS.map((a) => [a.id, a.mode, a.prefillUrl, a.plainUrl])).toEqual([
      ["chatgpt", "prefill", "https://chatgpt.com/?prompt={prompt}", "https://chatgpt.com/"],
      ["claude", "prefill", "https://claude.ai/new?q={prompt}", "https://claude.ai/new"],
      ["grok", "prefill", "https://grok.com/?q={prompt}", "https://grok.com/"],
      ["gemini", "paste", undefined, GEMINI],
    ]);
  });

  it("shows the label and the five buttons with their product names", () => {
    render(<AiHandoff row={row} />);
    expect(screen.getByText("Or run the evaluation in your own AI")).toBeTruthy();
    for (const [name, title] of [
      ["Open the prompt in ChatGPT", "ChatGPT"],
      ["Open the prompt in Claude", "Claude"],
      ["Open the prompt in Grok", "Grok"],
      ["Copy the prompt for Gemini", "Gemini"],
      ["Copy the prompt", "Copy the prompt"],
    ] as const) {
      expect(screen.getByRole("button", { name }).getAttribute("title")).toBe(title);
    }
  });

  it.each([
    ["ChatGPT", "https://chatgpt.com/?prompt="],
    ["Claude", "https://claude.ai/new?q="],
    ["Grok", "https://grok.com/?q="],
  ] as const)("%s opens a prefilled tab at once, copies and toasts", async (product, base) => {
    render(<AiHandoff row={row} />);
    const prompt = buildResearchPrompt(row);
    click(`Open the prompt in ${product}`);
    // the tab opens synchronously in the click, before the clipboard promise settles
    expect(open).toHaveBeenCalledWith(
      `${base}${encodeURIComponent(prompt)}`,
      "_blank",
      "noopener,noreferrer",
    );
    expect(writeText).toHaveBeenCalledWith(prompt);
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        `Prompt copied and ${product} opened in a new tab. Review it there and press Send.`,
      ),
    );
  });

  it("falls back to the plain new-chat URL when the encoded URL is over 8,000 characters", async () => {
    const long = makeDiscount({ name: "x".repeat(9000), yahoo_symbol: "LONG" });
    render(<AiHandoff row={long} />);
    click("Open the prompt in Claude");
    expect(open).toHaveBeenLastCalledWith("https://claude.ai/new", "_blank", "noopener,noreferrer");
    click("Open the prompt in Grok");
    expect(open).toHaveBeenLastCalledWith("https://grok.com/", "_blank", "noopener,noreferrer");
    expect(writeText).toHaveBeenCalledWith(buildResearchPrompt(long));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));
  });

  it("when the clipboard is refused, a prefill tab still opens and only the error toast shows", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<AiHandoff row={row} />);
    click("Open the prompt in Claude");
    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("ChatGPT opens a prefilled tab with the prompt in its box, copies and toasts", async () => {
    render(<AiHandoff row={row} />);
    const prompt = buildResearchPrompt(row);
    click("Open the prompt in ChatGPT");
    // the tab opens synchronously in the click, before the clipboard promise settles
    expect(open).toHaveBeenCalledWith(
      `https://chatgpt.com/?prompt=${encodeURIComponent(prompt)}`,
      "_blank",
      "noopener,noreferrer",
    );
    expect(writeText).toHaveBeenCalledWith(prompt);
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        "Prompt copied and ChatGPT opened in a new tab. Review it there and press Send.",
      ),
    );
  });

  it("Gemini copies, opens no tab, and the toast action opens the plain URL", async () => {
    render(<AiHandoff row={row} />);
    click("Copy the prompt for Gemini");
    expect(writeText).toHaveBeenCalledWith(buildResearchPrompt(row));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(open).not.toHaveBeenCalled();
    const [message, options] = toasts.success.mock.calls[0] ?? [];
    expect(message).toBe("Prompt copied.");
    expect(options?.description).toBe(
      "Open Gemini and paste it with Ctrl+V, or long-press and Paste on a phone.",
    );
    expect(options?.duration).toBe(12000);
    expect(options?.action.label).toBe("Open Gemini");
    options?.action.onClick();
    expect(open).toHaveBeenCalledWith(GEMINI, "_blank", "noopener,noreferrer");
  });

  it("Gemini with a refused clipboard shows the error toast and still offers the action", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<AiHandoff row={row} />);
    click("Copy the prompt for Gemini");
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    const [message, options] = toasts.error.mock.calls[0] ?? [];
    expect(message).toBe("Could not copy the prompt.");
    expect(options?.action.label).toBe("Open Gemini");
    options?.action.onClick();
    expect(open).toHaveBeenCalledWith(GEMINI, "_blank", "noopener,noreferrer");
  });

  it("Copy writes to the clipboard only, and toasts Prompt copied.", async () => {
    render(<AiHandoff row={row} />);
    click("Copy the prompt");
    expect(open).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(buildResearchPrompt(row));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Prompt copied."));
  });
});
