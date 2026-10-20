import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { COUNTRY_CODES, CountryFlag } from "./country-flag";

afterEach(cleanup);

const YAHOO_NAMES = [
  "United States",
  "China",
  "Canada",
  "Japan",
  "United Kingdom",
  "France",
  "Switzerland",
  "Germany",
  "Taiwan",
  "Ireland",
  "India",
  "Sweden",
  "Hong Kong",
  "South Korea",
  "Netherlands",
  "Brazil",
  "Australia",
  "Italy",
  "Singapore",
  "Saudi Arabia",
  "Spain",
  "Norway",
  "Mexico",
  "Finland",
  "Denmark",
  "Uruguay",
  "Peru",
  "Belgium",
  "Thailand",
  "Luxembourg",
  "Indonesia",
  "Bermuda",
];

describe("CountryFlag", () => {
  it("maps every Yahoo country name seen today to an ISO alpha-2 code and a real flag", () => {
    for (const name of YAHOO_NAMES) {
      expect(COUNTRY_CODES[name], name).toMatch(/^[A-Z]{2}$/);
      const { container, unmount } = render(<CountryFlag country={name} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("data-flag"), name).toBe(COUNTRY_CODES[name]);
      unmount();
    }
  });

  it("a flag is decorative, 20 by 14", () => {
    const { container } = render(<CountryFlag country="Taiwan" />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("14");
  });

  it("an unknown or null country gets the neutral placeholder", () => {
    for (const country of [null, undefined, "Atlantis", ""]) {
      const { container, unmount } = render(<CountryFlag country={country} />);
      const svg = container.querySelector("svg") as SVGElement;
      expect(svg.getAttribute("data-flag")).toBe("unknown");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
  });
});
