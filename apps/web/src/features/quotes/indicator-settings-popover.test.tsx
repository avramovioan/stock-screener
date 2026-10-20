import { DEFAULT_SETTINGS } from "@core/indicator.ts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VISIBILITY } from "./indicator-settings";
import { IndicatorSettingsPopover } from "./indicator-settings-popover";

afterEach(cleanup);

function setup() {
  const props = {
    settings: DEFAULT_SETTINGS,
    visibility: DEFAULT_VISIBILITY,
    onApply: vi.fn(),
    onVisibilityChange: vi.fn(),
    onReset: vi.fn(),
  };
  render(<IndicatorSettingsPopover {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Indicator settings" }));
  return props;
}

describe("IndicatorSettingsPopover", () => {
  it("shows the length field, four mode selectors, the explanation and the scan note", () => {
    setup();
    expect((screen.getByLabelText(/Length/) as HTMLInputElement).value).toBe("2500");
    const modes = screen.getAllByLabelText(/Use σ multiplier \/ Use max high-low deviation/);
    expect(modes).toHaveLength(4);
    for (const m of modes) expect((m as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText(/Unchecking switches the mode; it does not hide the line/),
    ).toBeTruthy();
    expect(screen.getByText(/The daily screening scan always uses the defaults/)).toBeTruthy();
  });

  it("unchecking a mode and applying switches the mode and never changes visibility", () => {
    const p = setup();
    fireEvent.click(screen.getAllByLabelText(/Use σ multiplier/)[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(p.onApply).toHaveBeenCalledTimes(1);
    const applied = p.onApply.mock.calls[0]?.[0] as typeof DEFAULT_SETTINGS;
    expect(Object.values(applied).filter((v) => v === false)).toHaveLength(1);
    expect(p.onVisibilityChange).not.toHaveBeenCalled();
  });

  it("an invalid length shows an error and does not apply", () => {
    const p = setup();
    fireEvent.change(screen.getByLabelText(/Length/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert").textContent?.length).toBeGreaterThan(0);
    expect(p.onApply).not.toHaveBeenCalled();
  });

  it("show/hide checkboxes are separate and applied immediately", () => {
    const p = setup();
    fireEvent.click(screen.getByLabelText("Show +1 line"));
    expect(p.onVisibilityChange).toHaveBeenCalledWith("upper1", false);
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThanOrEqual(9); // 4 modes + 5 visibility
  });

  it("Reset to defaults calls onReset", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(p.onReset).toHaveBeenCalledTimes(1);
  });
});
