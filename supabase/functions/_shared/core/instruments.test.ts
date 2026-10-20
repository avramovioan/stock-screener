import { describe, expect, it } from "vitest";
import {
  instrumentRejection,
  isBdrSymbol,
  isBondLikeName,
  isFundLikeName,
  isIobSymbol,
  isLikelyDepositaryReceipt,
} from "./instruments.ts";

describe("isIobSymbol", () => {
  it.each(["0J8P.L", "0JQQ.L", "0K6F.L", "0O86.L", "0QOT.L", "0YXG.L"])(
    "%s is an IOB line",
    (s) => {
      expect(isIobSymbol(s)).toBe(true);
    },
  );
  it.each(["SHEL.L", "HSBA.L", "0J8P.XC", "0J8P", "00J8P.L", "0J8.L", "0j8p.L", "BP.L", "ULVR.L"])(
    "%s is not an IOB line",
    (s) => {
      expect(isIobSymbol(s)).toBe(false);
    },
  );
});

describe("isBondLikeName", () => {
  it.each([
    "Crédit Agricole S.A. 1.3% SNR BDS 08/02/2027 EUR1",
    "Crédit Agricole S.A. 1.4% BDS 20/07/2027 EUR1",
    "Crédit Agricole S.A. 2% BDS 02/05/2027 EUR15000",
    "ACME CORP 5% NOTES 2031",
    "Some Bank 3.25% SNR 2029",
    "Foo Finance 4.5% Bonds due 15/06/2030",
    "Acme Holdings 12/03/2028 EUR100",
  ])("%s is bond-like", (n) => {
    expect(isBondLikeName(n)).toBe(true);
  });
  it.each([
    "Crédit Agricole S.A.",
    "Apple Inc.",
    "HSBC HOLDINGS PLC ORD $0.50 (UK",
    "Berkshire Hathaway Inc.",
    "3M Company",
    "Toyota Motor Corporation",
    "Bank of Ireland 5% Preference Shares",
    "Sanofi",
  ])("%s is not bond-like", (n) => {
    expect(isBondLikeName(n)).toBe(false);
  });
  it("handles null and empty names", () => {
    expect(isBondLikeName(null)).toBe(false);
    expect(isBondLikeName("")).toBe(false);
  });
});

describe("instrumentRejection", () => {
  const ok = { symbol: "AAPL", quoteType: "EQUITY", name: "Apple Inc." };
  it("accepts a common share", () => {
    expect(instrumentRejection(ok)).toBeNull();
  });
  it.each([
    "ETF",
    "MUTUALFUND",
    "BOND",
    "WARRANT",
    "RIGHT",
    "INDEX",
    "CRYPTOCURRENCY",
    "FUTURE",
    "OPTION",
    "EQUITYLINKEDNOTE",
    "",
  ])("rejects quoteType %s", (quoteType) => {
    expect(instrumentRejection({ ...ok, quoteType })).toBe("not_equity");
  });
  it("rejects a bond that Yahoo labels EQUITY by its name", () => {
    expect(
      instrumentRejection({
        symbol: "ACALK.PA",
        quoteType: "EQUITY",
        name: "Crédit Agricole S.A. 1.3% SNR BDS 08/02/2027 EUR1",
      }),
    ).toBe("bond_like");
  });
  it("rejects a London international order book line", () => {
    expect(
      instrumentRejection({
        symbol: "0J8P.L",
        quoteType: "EQUITY",
        name: "IDEXX Laboratories, Inc.",
      }),
    ).toBe("iob_line");
  });
  it("checks the quote type before the name", () => {
    expect(
      instrumentRejection({ symbol: "X.PA", quoteType: "BOND", name: "Foo 1% BDS 2027" }),
    ).toBe("not_equity");
  });
});

describe("isLikelyDepositaryReceipt", () => {
  it.each([
    "Arm Holdings plc American Depositary Shares",
    "Foo Ltd Sponsored ADR",
    "Bar SA ADS",
    "Baz GDR",
    "Qux Depositary Receipts",
  ])("%s has a marker", (name) => {
    expect(
      isLikelyDepositaryReceipt({ name, currencyMajor: "USD", financialCurrency: "USD" }),
    ).toBe(true);
  });
  it("a trading currency that differs from the reporting currency is a secondary signal", () => {
    expect(
      isLikelyDepositaryReceipt({
        name: "Novo Nordisk A/S",
        currencyMajor: "USD",
        financialCurrency: "DKK",
      }),
    ).toBe(true);
  });
  it.each([
    ["Accenture plc", "USD", "USD"],
    ["Apple Inc.", "USD", "USD"],
    ["Adsorb Corp", "USD", "USD"],
    ["Nokia Oyj", null, null],
    ["Nokia Oyj", "EUR", null],
    ["Nokia Oyj", null, "EUR"],
  ])("%s (%s/%s) is not flagged", (name, currencyMajor, financialCurrency) => {
    expect(isLikelyDepositaryReceipt({ name, currencyMajor, financialCurrency })).toBe(false);
  });
  it("handles a null name", () => {
    expect(
      isLikelyDepositaryReceipt({ name: null, currencyMajor: "USD", financialCurrency: "USD" }),
    ).toBe(false);
  });
});

describe("isBdrSymbol", () => {
  it.each([
    "ROXO34.SA",
    "T2TD34.SA",
    "S1PO34.SA",
    "GOGL35.SA",
    "JBSS32.SA",
    "NETE34.SA",
    "ASML34.SA",
  ])("%s is a BDR", (s) => {
    expect(isBdrSymbol(s)).toBe(true);
  });
  it.each([
    "PETR4.SA",
    "VALE3.SA",
    "ITUB4.SA",
    "ABEV3.SA",
    "SANB11.SA",
    "BBDC4.SA",
    "AAPL34",
    "SAP.DE",
    "WEGE3.SA",
  ])("%s is not a BDR", (s) => {
    expect(isBdrSymbol(s)).toBe(false);
  });
});

describe("isFundLikeName", () => {
  it.each([
    "Vanguard All-World ex-US Shares Index ETF",
    "iShares Core S&P 500 ETF",
    "Foo Bank ETN 2030",
    "Graniteshares YieldBOOST 20Y+ Treasuries ETF",
    "Acme Index Fund",
  ])("%s is fund-like", (n) => {
    expect(isFundLikeName(n)).toBe(true);
  });
  it.each(["Apple Inc.", "Etfa Holdings", "Netflix, Inc.", "Fund Holdings Corp", null])(
    "%s is not",
    (n) => {
      expect(isFundLikeName(n)).toBe(false);
    },
  );
});

describe("instrumentRejection (BDR and fund names)", () => {
  it("rejects a Brazilian depositary receipt and a fund that Yahoo labels EQUITY", () => {
    expect(
      instrumentRejection({ symbol: "ROXO34.SA", quoteType: "EQUITY", name: "Nu Holdings Ltd." }),
    ).toBe("bdr_line");
    expect(
      instrumentRejection({
        symbol: "VEU.AX",
        quoteType: "EQUITY",
        name: "Vanguard All-World ex-US Shares Index ETF",
      }),
    ).toBe("fund_like");
  });
});
