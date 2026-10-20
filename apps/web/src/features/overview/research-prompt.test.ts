import { describe, expect, it } from "vitest";
import { makeDiscount } from "@/test/fixtures";
import { buildResearchPrompt } from "./research-prompt";

const us = makeDiscount({
  yahoo_symbol: "MCD",
  name: "McDonald's Corporation",
  exchange_code: "NYQ",
  exchange_name: "NYSE",
  country: "United States",
  listing_country: "United States",
  close: 242.97,
  currency: "USD",
  session_date: "2026-10-16",
  line3_end: 265.89,
  line4_end: 246.99,
});
const fr = makeDiscount({
  yahoo_symbol: "RMS.PA",
  name: "Hermès International",
  exchange_code: "PAR",
  exchange_name: "Euronext Paris",
  country: "France",
  listing_country: "France",
  close: 2183,
  currency: "EUR",
  session_date: "2026-10-19",
  line3_end: 2210,
  line4_end: 2071,
});

describe("buildResearchPrompt", () => {
  it("states the company facts: name, home ticker, exchange, country, close and the two lines", () => {
    const text = buildResearchPrompt(fr);
    expect(text).toContain("Hermès International");
    expect(text).toContain("RMS (Yahoo RMS.PA)");
    expect(text).toContain("Euronext Paris");
    expect(text).toContain("France");
    expect(text).toContain("2,183.00");
    expect(text).toContain("19 Oct 2026");
    expect(text).toContain("2,210.00");
    expect(text).toContain("2,071.00");
  });

  it("opens with the strategy role line and asks the two questions", () => {
    const text = buildResearchPrompt(us);
    expect(text).toContain(
      "My strategy identifies stocks whose prices have fallen substantially below their historical trend.",
    );
    expect(text).toContain(
      "Is the stock falling for temporary reasons, or because of lasting damage to the business?",
    );
    expect(text).toContain(
      "Is the company at risk of bankruptcy, or financially strong enough to survive its current problems?",
    );
  });

  it("asks for the output: conclusion, bankruptcy risk Low/Moderate/High/Unclear, facts with sources, limitations", () => {
    const text = buildResearchPrompt(us);
    expect(text).toContain("short conclusion");
    expect(text).toContain("Low, Moderate, High or Unclear");
    expect(text).toContain("facts with their sources");
    expect(text).toContain("limitations");
  });

  it("a US listing points to SEC EDGAR and the 10-K, 10-Q and 8-K", () => {
    const text = buildResearchPrompt(us);
    expect(text).toContain(
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=McDonald's%20Corporation",
    );
    expect(text).toContain("10-K");
    expect(text).toContain("10-Q");
    expect(text).toContain("8-K");
    expect(text).not.toContain("investor relations");
  });

  it("a non-US listing points to the investor relations site and the annual and interim reports", () => {
    const text = buildResearchPrompt(fr);
    expect(text).toContain("investor relations");
    expect(text).toContain("annual and interim reports");
    expect(text).not.toContain("sec.gov");
    expect(text).not.toContain("10-K");
  });

  it("every prompt asks for news of the last 90 days about the price fall", () => {
    for (const row of [us, fr]) {
      expect(buildResearchPrompt(row)).toContain("last 90 days");
    }
  });
});
