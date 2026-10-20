import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KpiCard } from "./kpi-card";

describe("KpiCard", () => {
  it("shows the title, the content and a provenance badge in text for each origin", () => {
    render(
      <KpiCard title="Cost basis" provenance={["broker"]}>
        <p>4,716.56 EUR</p>
      </KpiCard>,
    );
    const card = screen.getByRole("article", { name: "Cost basis" });
    expect(within(card).getByText("4,716.56 EUR")).toBeTruthy();
    expect(within(card).getByText("Broker-reported")).toBeTruthy();
  });

  it("a card may carry both origins and a note", () => {
    render(
      <KpiCard
        title="Total portfolio value"
        provenance={["broker", "calculated"]}
        note="NAV is the statement value."
      >
        <p>x</p>
      </KpiCard>,
    );
    expect(screen.getByText("Broker-reported")).toBeTruthy();
    expect(screen.getByText("Calculated by this app")).toBeTruthy();
    expect(screen.getByText("NAV is the statement value.")).toBeTruthy();
  });
});
