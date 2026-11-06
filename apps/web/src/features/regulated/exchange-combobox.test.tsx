import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ExchangeCombobox } from "./exchange-combobox";
import { FIXTURE_EXCHANGES } from "./test-fixtures";

afterEach(cleanup);

function Harness() {
  const [value, setValue] = useState("");
  return (
    <ExchangeCombobox
      id="mic"
      label="Exchange"
      exchanges={FIXTURE_EXCHANGES}
      value={value}
      onChange={setValue}
    />
  );
}

const input = () => screen.getByRole("combobox", { name: "Exchange" }) as HTMLInputElement;

describe("ExchangeCombobox", () => {
  it("is collapsed until focused, then lists everything grouped by country", () => {
    render(<Harness />);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    fireEvent.focus(input());
    expect(input().getAttribute("aria-expanded")).toBe("true");
    const groups = screen.getAllByRole("group").map((g) => g.textContent);
    expect(groups[0]).toMatch(/^Austria/);
    expect(screen.getAllByRole("option")).toHaveLength(FIXTURE_EXCHANGES.length);
  });

  it("typing XET shows a Germany section with the MIC and the grayed full name", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "XET" } });
    const germany = screen.getByRole("group", { name: "Germany" });
    const option = within(germany).getByRole("option");
    expect(option.textContent).toBe("XETRDeutsche Börse Xetra");
    expect(within(option).getByText("XETR").className).toContain("font-semibold");
    expect(within(option).getByText("Deutsche Börse Xetra").className).toContain(
      "text-muted-foreground",
    );
  });

  it("arrows, Home and End move the active option; Enter selects its MIC", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "XET" } }); // XETB (AT) then XETR (DE)
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(input().getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "End" });
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "Home" });
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "ArrowUp" }); // wraps to the last
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input().value).toBe("XETR");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes the list and keeps the typed text", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "xp" } });
    expect(input().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().value).toBe("xp");
  });

  it("clicking an option selects it", () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.click(screen.getByRole("option", { name: /XPAR/ }));
    expect(input().value).toBe("XPAR");
  });

  it("shows no popup when nothing matches", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "zzzz" } });
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the list right after the input inside a relative anchor", () => {
    render(<Harness />);
    const anchor = input().parentElement as HTMLElement;
    expect(anchor.className).toContain("relative");
    expect(input().nextElementSibling).toBe(screen.getByRole("listbox", { hidden: true }));
    expect(anchor.contains(screen.getByText("Exchange"))).toBe(false);
  });

  it("mousedown on a group header does not blur the input", () => {
    render(<Harness />);
    input().focus();
    fireEvent.focus(input());
    const header = screen.getByText("Austria");
    expect(fireEvent.mouseDown(header)).toBe(false); // default prevented, so focus stays
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  it("reopening after a selection lists all exchanges with the selected one active", () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.click(screen.getByRole("option", { name: /XPAR/ }));
    expect(input().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(input());
    expect(screen.getAllByRole("option")).toHaveLength(FIXTURE_EXCHANGES.length);
    expect(screen.getByRole("option", { name: /XPAR/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.change(input(), { target: { value: "XET" } });
    expect(screen.getAllByRole("option").length).toBeLessThan(FIXTURE_EXCHANGES.length);
  });
});
