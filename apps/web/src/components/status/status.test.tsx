import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CategoryBadge } from "./category-badge";
import { FreshnessTag } from "./freshness-tag";
import { MovementCell } from "./movement-cell";
import { StatusBanner } from "./status-banner";
import { ValuationTag } from "./valuation-tag";

afterEach(cleanup);

describe("CategoryBadge", () => {
  const cases = [
    ["green", "Meets checks"],
    ["amber", "Caution"],
    ["red", "Not cleared"],
    ["grey", "Inconclusive"],
    ["pending", "Research pending"],
  ] as const;
  for (const [category, label] of cases) {
    it(`${category} renders the text "${label}" with an icon and an aria-label`, () => {
      const { container } = render(<CategoryBadge category={category} />);
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByLabelText(`Category: ${label}`)).toBeTruthy();
      expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    });
  }
  it("amber long form names the risk", () => {
    render(<CategoryBadge category="amber" long />);
    expect(screen.getByText("Caution: moderate bankruptcy risk")).toBeTruthy();
  });
});

describe("ValuationTag", () => {
  const cases = [
    ["discounted", "Discounted"],
    ["premium", "Premium"],
    ["extra_premium", "Extra premium"],
    ["unavailable", "Unavailable"],
  ] as const;
  for (const [kind, label] of cases) {
    it(`${kind} renders "${label}"`, () => {
      render(<ValuationTag kind={kind} />);
      expect(screen.getByText(label)).toBeTruthy();
    });
  }
});

describe("FreshnessTag", () => {
  it("fresh shows the close date as text", () => {
    render(<FreshnessTag freshness="fresh" sessionDate="2026-10-14" />);
    expect(screen.getByText("close 14 Oct 2026")).toBeTruthy();
  });
  it("stale shows a stale tag and the session date", () => {
    render(<FreshnessTag freshness="stale" sessionDate="2026-10-09" />);
    expect(screen.getByText(/Stale/)).toBeTruthy();
    expect(screen.getByText(/9 Oct 2026/)).toBeTruthy();
  });
  it("unavailable and null render Unavailable, never a number", () => {
    const { rerender } = render(<FreshnessTag freshness="unavailable" />);
    expect(screen.getByText("Unavailable")).toBeTruthy();
    rerender(<FreshnessTag freshness={null} />);
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });
});

describe("MovementCell", () => {
  it("positive: sign, arrow glyph and a spoken label", () => {
    const { container } = render(<MovementCell pct={1.234} />);
    expect(screen.getByText("+1.23%")).toBeTruthy();
    expect(screen.getByLabelText("Up 1.23 percent")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
  });
  it("negative", () => {
    render(<MovementCell pct={-0.5} />);
    expect(screen.getByText("-0.50%")).toBeTruthy();
    expect(screen.getByLabelText("Down 0.50 percent")).toBeTruthy();
  });
  it("zero is unchanged, not n/a", () => {
    render(<MovementCell pct={0} />);
    expect(screen.getByText("0.00%")).toBeTruthy();
    expect(screen.getByLabelText("Unchanged")).toBeTruthy();
  });
  it("null is n/a with an explanation", () => {
    render(<MovementCell pct={null} />);
    expect(screen.getByText("n/a")).toBeTruthy();
    expect(screen.getByLabelText("Movement unavailable")).toBeTruthy();
  });
});

describe("StatusBanner", () => {
  it("renders nothing when the scan is fine", () => {
    const { container } = render(<StatusBanner state="ok" />);
    expect(container.firstChild).toBeNull();
  });
  it("partial scan shows the coverage numbers", () => {
    render(<StatusBanner state="partial" processed={590} total={612} />);
    expect(screen.getByRole("status").textContent).toContain(
      "Latest update incomplete: 590 of 612 securities processed",
    );
  });
  it("partial excludes short-history companies from the denominator", () => {
    render(<StatusBanner state="partial" processed={432} total={491} insufficientData={58} />);
    expect(screen.getByRole("status").textContent).toContain(
      "Latest update incomplete: 432 of 433 securities processed. 58 excluded for short price history. Results may be missing; nothing unprocessed is shown as passing.",
    );
  });
  it("partial counts skipped listings out of the denominator and names them", () => {
    render(
      <StatusBanner
        state="partial"
        processed={431}
        total={490}
        insufficientData={58}
        skipped={1}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Latest update incomplete: 431 of 431 securities processed. 58 excluded for short price history. 1 skipped for missing price data. Results may be missing; nothing unprocessed is shown as passing.",
    );
  });
  it("failed names the excluded short-history companies", () => {
    render(<StatusBanner state="failed" processed={432} total={491} insufficientData={58} />);
    expect(screen.getByRole("status").textContent).toContain(
      "Latest scan failed: 432 of 433 securities processed. 58 excluded for short price history.",
    );
  });
  it("partial without numbers still explains itself", () => {
    render(<StatusBanner state="partial" />);
    expect(screen.getByRole("status").textContent).toContain("Latest update incomplete");
  });
  it("failed shows the coverage numbers when known", () => {
    render(<StatusBanner state="failed" processed={590} total={612} />);
    expect(screen.getByRole("status").textContent).toContain(
      "Latest scan failed: 590 of 612 securities processed",
    );
  });
  it("stale shows the last scan time, age, session date and coverage", () => {
    render(
      <StatusBanner
        state="stale"
        lastScanAt="2026-10-13T07:41:00Z"
        ageHours={52}
        sessionDate="2026-10-12"
        processed={590}
        total={612}
      />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Data is stale: last completed scan 13 Oct 2026, 10:41, 52 hours ago.");
    expect(text).toContain("Latest session 12 Oct 2026.");
    expect(text).toContain("590 of 612 securities processed.");
  });
  it("failed, stale and none have distinct text", () => {
    const { rerender } = render(<StatusBanner state="failed" />);
    expect(screen.getByRole("status").textContent).toContain("Latest scan failed");
    rerender(<StatusBanner state="stale" />);
    expect(screen.getByRole("status").textContent).toContain("Data is stale");
    rerender(<StatusBanner state="none" />);
    expect(screen.getByRole("status").textContent).toContain("No scan published yet");
  });
});
