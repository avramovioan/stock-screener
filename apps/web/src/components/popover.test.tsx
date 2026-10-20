import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Popover } from "./popover";

afterEach(cleanup);

function setup() {
  render(
    <div>
      <Popover trigger="Open" triggerLabel="Open list" panelLabel="The list">
        <p>Inside</p>
      </Popover>
      <button type="button">Outside</button>
    </div>,
  );
  return screen.getByRole("button", { name: "Open list" });
}

describe("Popover", () => {
  it("is closed initially and exposes aria-expanded", () => {
    const btn = setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
  it("opens on click and labels the dialog", () => {
    const btn = setup();
    fireEvent.click(btn);
    expect(screen.getByRole("dialog", { name: "The list" })).toBeTruthy();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });
  it("Escape closes it and returns focus to the trigger", () => {
    const btn = setup();
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });
  it("closes on an outside pointerdown (touch and pen included)", () => {
    const btn = setup();
    fireEvent.click(btn);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
