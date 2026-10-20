import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PositionCard } from "./position-card";
import type { HeldPosition } from "./types";

const POSITION: HeldPosition = {
  quantity: 12,
  averageCost: 400.18,
  currency: "EUR",
  marketValue: { kind: "ok", value: 5414.4, ccy: "EUR" },
  unrealized: { kind: "ok", value: 612.3, ccy: "EUR" },
  heldSymbol: "MSF",
  heldExchange: "IBIS",
  reportDate: "2026-10-17",
};
afterEach(() => cleanup());

describe("PositionCard", () => {
  it("shows the four figures, the statement date and the held line", () => {
    render(<PositionCard position={POSITION} />);
    const card = screen.getByRole("region", { name: "Your position" });
    expect(within(card).getByText("IBKR statement of 17 Oct 2026")).toBeTruthy();
    expect(within(card).getByText("12")).toBeTruthy();
    expect(within(card).getByText("400.18 EUR")).toBeTruthy();
    expect(within(card).getByText("5,414.40 EUR")).toBeTruthy();
    expect(within(card).getByText("+612.30 EUR")).toBeTruthy();
    expect(card.textContent).toContain(
      "Held as MSF on Xetra (IBIS), EUR. Trades from today show up after tomorrow's statement.",
    );
  });

  it("uses a two by two grid on a phone and four across from sm", () => {
    render(<PositionCard position={POSITION} />);
    const cls = screen.getByText("Shares").closest("dl")?.className ?? "";
    expect(cls).toContain("grid-cols-2");
    expect(cls).toContain("sm:grid-cols-4");
  });

  it("omits the date when unknown and says unavailable for a missing cost", () => {
    render(
      <PositionCard
        position={{ ...POSITION, reportDate: null, averageCost: null, quantity: 1.5 }}
      />,
    );
    expect(screen.queryByText(/IBKR statement of/)).toBeNull();
    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(screen.getByText("1.5")).toBeTruthy();
  });

  it("names Amsterdam, other codes and no exchange", () => {
    const { rerender } = render(
      <PositionCard position={{ ...POSITION, heldSymbol: "VUSA", heldExchange: "AEB" }} />,
    );
    expect(screen.getByText(/Held as VUSA on Amsterdam \(AEB\), EUR\./)).toBeTruthy();
    rerender(<PositionCard position={{ ...POSITION, heldExchange: "IBIS2" }} />);
    expect(screen.getByText(/Held as MSF on Xetra \(IBIS2\), EUR\./)).toBeTruthy();
    rerender(<PositionCard position={{ ...POSITION, heldExchange: "LSEETF" }} />);
    expect(screen.getByText(/Held as MSF on LSEETF, EUR\./)).toBeTruthy();
    rerender(<PositionCard position={{ ...POSITION, heldExchange: null }} />);
    expect(screen.getByText(/^Held as MSF, EUR\./)).toBeTruthy();
  });
});
