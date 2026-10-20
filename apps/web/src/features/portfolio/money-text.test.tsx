import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatAmount, MoneyText } from "./money-text";

describe("MoneyText", () => {
  it("formats an ok amount with the currency code as text and tabular figures", () => {
    render(<MoneyText money={{ kind: "ok", value: 2320, ccy: "USD" }} />);
    expect(screen.getByText("2,320.00 USD")).toBeTruthy();
  });

  it("signed amounts show an explicit sign and zero stays a real zero", () => {
    render(<MoneyText money={{ kind: "ok", value: 318.3, ccy: "EUR" }} signed />);
    expect(screen.getByText("+318.30 EUR")).toBeTruthy();
    render(<MoneyText money={{ kind: "ok", value: 0, ccy: "EUR" }} signed />);
    expect(screen.getByText("0.00 EUR")).toBeTruthy();
    render(<MoneyText money={{ kind: "ok", value: -5, ccy: "EUR" }} signed />);
    expect(screen.getByText("-5.00 EUR")).toBeTruthy();
  });

  it("an unavailable amount is a dash with the reason for screen readers, never 0", () => {
    render(<MoneyText money={{ kind: "unavailable", reason: "Missing FX rate USD->EUR" }} />);
    expect(screen.getByText("Unavailable: Missing FX rate USD->EUR")).toBeTruthy();
    expect(screen.queryByText(/0\.00/)).toBeNull();
    expect(screen.getByTitle("Missing FX rate USD->EUR")).toBeTruthy();
  });

  it("formatAmount keeps sub-unit precision for small prices", () => {
    expect(formatAmount(0.0123)).toBe("0.0123");
    expect(formatAmount(1234.5)).toBe("1,234.50");
  });
});
