export interface TradingViewLink {
  url: string;
  /** false when the exchange mapping or the ticker form is not verified (spec 14.5). */
  verified: boolean;
}

interface PrefixEntry {
  prefix: string;
  verified: boolean;
}

/**
 * Yahoo exchange code -> TradingView prefix. The 23 verified rows are copied verbatim from
 * docs/discovery/research/yahoo-finance2-spike.md section 7. The unverified rows are the ones the
 * spike names with a prefix; exchanges the spike lists without a prefix (VIE, STO, HEL, CPH, OSL,
 * WSE, TLV, IST) are deliberately absent, so they return null and the UI shows plain text.
 */
export const TRADINGVIEW_PREFIX: Readonly<Record<string, PrefixEntry>> = {
  NMS: { prefix: "NASDAQ", verified: true },
  NYQ: { prefix: "NYSE", verified: true },
  GER: { prefix: "XETR", verified: true },
  FRA: { prefix: "FWB", verified: true },
  AMS: { prefix: "EURONEXT", verified: true },
  PAR: { prefix: "EURONEXT", verified: true },
  MIL: { prefix: "MIL", verified: true },
  LSE: { prefix: "LSE", verified: true },
  JPX: { prefix: "TSE", verified: true },
  HKG: { prefix: "HKEX", verified: true },
  NSI: { prefix: "NSE", verified: true },
  SAU: { prefix: "TADAWUL", verified: true },
  EBS: { prefix: "SIX", verified: true },
  SES: { prefix: "SGX", verified: true },
  KSC: { prefix: "KRX", verified: true },
  TAI: { prefix: "TWSE", verified: true },
  SHH: { prefix: "SSE", verified: true },
  SHZ: { prefix: "SZSE", verified: true },
  TOR: { prefix: "TSX", verified: true },
  ASX: { prefix: "ASX", verified: true },
  SAO: { prefix: "BMFBOVESPA", verified: true },
  MEX: { prefix: "BMV", verified: true },
  JNB: { prefix: "JSE", verified: true },
  KOE: { prefix: "KRX", verified: false },
  BSE: { prefix: "BSE", verified: false },
  TWO: { prefix: "TPEX", verified: false },
  NGM: { prefix: "NASDAQ", verified: false },
  NCM: { prefix: "NASDAQ", verified: false },
  PCX: { prefix: "NYSEARCA", verified: false },
  ASE: { prefix: "AMEX", verified: false },
};

const US_EXCHANGES = new Set(["NMS", "NYQ", "NGM", "NCM", "PCX", "ASE"]);

/** `https://www.tradingview.com/symbols/<PREFIX>-<TICKER>/`; null when the exchange has no prefix. */
export function tradingViewUrl(exchangeCode: string, symbol: string): TradingViewLink | null {
  const entry = TRADINGVIEW_PREFIX[exchangeCode];
  if (!entry) return null;
  let ticker = symbol;
  let verified = entry.verified;
  if (US_EXCHANGES.has(exchangeCode)) {
    if (ticker.includes("-")) {
      ticker = ticker.replace(/-/g, "."); // BRK-B -> BRK.B; share-class form was not tested in the spike
      verified = false;
    }
  } else {
    ticker = ticker.replace(/\.[A-Za-z]{1,2}$/, ""); // drop the Yahoo exchange suffix (.DE, .T, .HK, ...)
    if (ticker.includes("-")) {
      ticker = ticker.replace(/-/g, "."); // BT-A.L -> BT.A: share-class form, not spike-verified
      verified = false;
    }
  }
  if (exchangeCode === "HKG") ticker = ticker.replace(/^0+(?=\d)/, ""); // HKEX-0700 is 404, HKEX-700 is 200
  return {
    url: `https://www.tradingview.com/symbols/${entry.prefix}-${encodeURIComponent(ticker)}/`,
    verified,
  };
}

export function yahooUrl(symbol: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
}
