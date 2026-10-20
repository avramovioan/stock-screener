import { describe, expect, it } from "vitest";
import { TRADINGVIEW_PREFIX, tradingViewUrl, yahooUrl } from "./deeplinks";

// Verified table copied verbatim from docs/discovery/research/yahoo-finance2-spike.md section 7.
const VERIFIED: [exchange: string, symbol: string, expected: string][] = [
  ["NMS", "MSFT", "NASDAQ-MSFT"],
  ["NYQ", "JPM", "NYSE-JPM"],
  ["GER", "MSF.DE", "XETR-MSF"],
  ["FRA", "MSF.F", "FWB-MSF"],
  ["AMS", "ASML.AS", "EURONEXT-ASML"],
  ["PAR", "MC.PA", "EURONEXT-MC"],
  ["MIL", "ENI.MI", "MIL-ENI"],
  ["LSE", "SHEL.L", "LSE-SHEL"],
  ["JPX", "7203.T", "TSE-7203"],
  ["HKG", "0700.HK", "HKEX-700"],
  ["NSI", "RELIANCE.NS", "NSE-RELIANCE"],
  ["SAU", "2222.SR", "TADAWUL-2222"],
  ["EBS", "NESN.SW", "SIX-NESN"],
  ["SES", "D05.SI", "SGX-D05"],
  ["KSC", "005930.KS", "KRX-005930"],
  ["TAI", "2330.TW", "TWSE-2330"],
  ["SHH", "600519.SS", "SSE-600519"],
  ["SHZ", "000858.SZ", "SZSE-000858"],
  ["TOR", "TD.TO", "TSX-TD"],
  ["ASX", "BHP.AX", "ASX-BHP"],
  ["SAO", "VALE3.SA", "BMFBOVESPA-VALE3"],
  ["MEX", "AAPL.MX", "BMV-AAPL"],
  ["JNB", "NPN.JO", "JSE-NPN"],
];

describe("tradingViewUrl: every verified exchange code", () => {
  for (const [exchange, symbol, expected] of VERIFIED) {
    it(`${exchange} ${symbol} -> ${expected}`, () => {
      expect(tradingViewUrl(exchange, symbol)).toEqual({
        url: `https://www.tradingview.com/symbols/${expected}/`,
        verified: true,
      });
    });
  }
  it("covers all 23 verified rows", () => {
    expect(VERIFIED).toHaveLength(23);
    for (const [exchange] of VERIFIED) expect(TRADINGVIEW_PREFIX[exchange]?.verified).toBe(true);
  });
});

describe("tradingViewUrl: special cases", () => {
  it("maps a non-US share class dash to a dot and marks it unverified (BT-A.L -> LSE-BT.A)", () => {
    expect(tradingViewUrl("LSE", "BT-A.L")).toEqual({
      url: "https://www.tradingview.com/symbols/LSE-BT.A/",
      verified: false,
    });
  });

  it("strips HKEX leading zeros but keeps a lone zero", () => {
    expect(tradingViewUrl("HKG", "0005.HK")?.url).toBe(
      "https://www.tradingview.com/symbols/HKEX-5/",
    );
    expect(tradingViewUrl("HKG", "09988.HK")?.url).toBe(
      "https://www.tradingview.com/symbols/HKEX-9988/",
    );
    expect(tradingViewUrl("HKG", "0000.HK")?.url).toBe(
      "https://www.tradingview.com/symbols/HKEX-0/",
    );
  });
  it("does not strip leading zeros on other exchanges (KRX, SZSE keep them)", () => {
    expect(tradingViewUrl("KSC", "005930.KS")?.url).toBe(
      "https://www.tradingview.com/symbols/KRX-005930/",
    );
  });
  it("maps a US share class BRK-B to BRK.B and marks it unverified", () => {
    expect(tradingViewUrl("NYQ", "BRK-B")).toEqual({
      url: "https://www.tradingview.com/symbols/NYSE-BRK.B/",
      verified: false,
    });
  });
  it("unverified exchanges still produce a best-effort link flagged unverified", () => {
    expect(tradingViewUrl("KOE", "035720.KQ")).toEqual({
      url: "https://www.tradingview.com/symbols/KRX-035720/",
      verified: false,
    });
    expect(tradingViewUrl("PCX", "SPY")?.verified).toBe(false);
  });
  it("returns null for an exchange without a prefix", () => {
    expect(tradingViewUrl("XXX", "ABC.XX")).toBeNull();
    expect(tradingViewUrl("VIE", "OMV.VI")).toBeNull();
  });
});

describe("yahooUrl", () => {
  it("builds https://finance.yahoo.com/quote/<symbol>/", () => {
    expect(yahooUrl("MSFT")).toBe("https://finance.yahoo.com/quote/MSFT/");
    expect(yahooUrl("0700.HK")).toBe("https://finance.yahoo.com/quote/0700.HK/");
    expect(yahooUrl("BRK-B")).toBe("https://finance.yahoo.com/quote/BRK-B/");
  });
  it("encodes characters that are not URL-safe", () => {
    expect(yahooUrl("^GSPC")).toBe("https://finance.yahoo.com/quote/%5EGSPC/");
  });
});
