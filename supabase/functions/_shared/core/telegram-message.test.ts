import { describe, expect, it } from "vitest";
import type { DiscountEntry } from "./digest.ts";
import { TELEGRAM_MAX_CHARS, telegramDigestMessage } from "./telegram-message.ts";

function entry(over: Partial<DiscountEntry> = {}): DiscountEntry {
  return {
    episodeId: "ep-1",
    companyId: "co-1",
    securityId: "sec-1",
    mode: "worldwide",
    alsoIn: [],
    rank: 4,
    yahooSymbol: "MSFT",
    name: "Microsoft Corporation",
    close: 400,
    ccy: "USD",
    sessionDate: "2026-10-20",
    line: "-3",
    isTop10: true,
    reachedLine4: false,
    category: "green",
    conclusion: "",
    bankruptcyRisk: "Low",
    summary: "",
    eur: null,
    ...over,
  };
}

const SITE = "https://screener.example.test/";

describe("telegramDigestMessage", () => {
  it("renders the headline, one line per company and the link", () => {
    const text = telegramDigestMessage(
      [entry(), entry({ yahooSymbol: "SAP.DE", ticker: "SAP", name: "SAP SE", rank: 12 })],
      "2026-10-21",
      SITE,
    );
    expect(text).toBe(
      [
        "<b>New on the screener · 21 Oct</b>",
        "• <b>MSFT</b> Microsoft Corporation · #4 · at its −3 line",
        "• <b>SAP</b> SAP SE · #12 · at its −3 line",
        "",
        '<a href="https://screener.example.test/">Open the screener</a>',
      ].join("\n"),
    );
  });

  it("names the -4 line of a legacy episode", () => {
    expect(telegramDigestMessage([entry({ line: "-4" })], "2026-10-21", SITE)).toContain(
      "at its −4 line",
    );
  });

  it("escapes <, > and & in every company field", () => {
    const text = telegramDigestMessage(
      [entry({ ticker: "A&B", name: "<b>Evil</b> & Sons" })],
      "2026-10-21",
      SITE,
    );
    expect(text).toContain("• <b>A&amp;B</b> &lt;b&gt;Evil&lt;/b&gt; &amp; Sons");
    expect(text).not.toContain("<b>Evil");
  });

  it("shows at most 20 companies, then how many more", () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      entry({ yahooSymbol: `T${i}`, name: `Company ${i}`, rank: i + 1 }),
    );
    const text = telegramDigestMessage(many, "2026-10-21", SITE);
    expect(text.split("\n").filter((l) => l.startsWith("• ")).length).toBe(20);
    expect(text).toContain("…and 3 more");
    expect(text).not.toContain("Company 20");
  });

  it("stays under the Telegram limit even with very long names", () => {
    const long = Array.from({ length: 20 }, (_, i) =>
      entry({ yahooSymbol: `T${i}`, name: "&".repeat(400), rank: i + 1 }),
    );
    const text = telegramDigestMessage(long, "2026-10-21", SITE);
    expect(text.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(text).toMatch(/…and \d+ more/);
    expect(text).toContain("Open the screener");
  });

  it("escapes quotes in the link", () => {
    expect(telegramDigestMessage([entry()], "2026-10-21", 'https://x.test/?a="b"&c')).toContain(
      '<a href="https://x.test/?a=&quot;b&quot;&amp;c">',
    );
  });
});
