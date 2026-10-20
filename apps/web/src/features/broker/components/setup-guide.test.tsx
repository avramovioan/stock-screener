import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FLEX_SECTIONS, LIMITS, REQUIREMENTS, SETUP_STEPS } from "../setup-content";
import { SetupGuide } from "./setup-guide";

describe("SetupGuide", () => {
  it("lists every setup step in order", () => {
    render(<SetupGuide />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    for (const step of SETUP_STEPS)
      expect(items.some((t) => t.includes(step.slice(0, 40)))).toBe(true);
  });

  it("names the Flex query settings: XML, 365 days, yyyyMMdd, no IP restriction", () => {
    render(<SetupGuide />);
    expect(screen.getByText(/Format XML, Period Last 365 Calendar Days/)).toBeTruthy();
    expect(screen.getByText(/Do not set an IP restriction/)).toBeTruthy();
  });

  it("lists every Flex section of the checklist and the Closed Lots warning", () => {
    render(<SetupGuide />);
    for (const s of FLEX_SECTIONS) expect(screen.getByText(s.section)).toBeTruthy();
    expect(screen.getByText(/Select both levels of detail/)).toBeTruthy();
  });

  it("states the requirements and what the integration cannot do (T+1, no orders)", () => {
    render(<SetupGuide />);
    for (const line of [...REQUIREMENTS, ...LIMITS]) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText(/T\+1/)).toBeTruthy();
  });
});
