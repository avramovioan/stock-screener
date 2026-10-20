// Which instruments may enter the universe (A-50): common shares only, and never a London international order book line.

export type InstrumentRejection =
  | "not_equity"
  | "bond_like"
  | "fund_like"
  | "iob_line"
  | "bdr_line";

/**
 * LSE international order book lines, e.g. 0J8P.L (IDEXX), 0JQQ.L (Archer-Daniels-Midland). They quote a foreign company in London and
 * carry its market cap but rarely any price history; they are never a company's primary listing.
 */
const IOB_SYMBOL = /^0[A-Z0-9]{3}\.L$/;
/** "1.3% SNR BDS", "5% NOTES", "4.5% Bonds": a coupon followed by a bond word. */
const COUPON_BOND = /\d+(?:\.\d+)?%\s.*\b(?:BDS|BONDS?|NOTES?|SNR)\b/i;
/** A dd/mm/yyyy maturity date inside an instrument name. */
const MATURITY_DATE = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/;

/** Brazilian depositary receipts (BDR): a ticker ending 32, 33, 34, 35 or 39 on B3, e.g. ROXO34.SA (Nu Holdings), T2TD34.SA. Real shares end in 3, 4, 5, 6 or 11. */
const BDR_SYMBOL = /^[A-Z0-9]{3,5}(?:32|33|34|35|39)\.SA$/;
/** Funds that Yahoo labels EQUITY (VEU.AX): the capitalised ETF, ETN or ETC token, or an index fund. */

export function isBdrSymbol(symbol: string): boolean {
  return BDR_SYMBOL.test(symbol);
}

export function isFundLikeName(name: string | null): boolean {
  if (name === null || name === "") return false;
  return /\b(?:ETF|ETN|ETC)\b/.test(name) || /\bindex fund\b/i.test(name);
}

export function isIobSymbol(symbol: string): boolean {
  return IOB_SYMBOL.test(symbol);
}

/** Safety net for bond-like listings that Yahoo labels EQUITY (the Crédit Agricole bonds on Paris). */
export function isBondLikeName(name: string | null): boolean {
  if (name === null || name === "") return false;
  return COUPON_BOND.test(name) || MATURITY_DATE.test(name);
}

/** Why a quote row must not enter the universe, or null for a common share. quoteType first, then the name, then the symbol shape. */
export function instrumentRejection(i: {
  symbol: string;
  quoteType: string | null | undefined;
  name: string | null;
}): InstrumentRejection | null {
  if (i.quoteType !== "EQUITY") return "not_equity";
  if (isBondLikeName(i.name)) return "bond_like";
  if (isFundLikeName(i.name)) return "fund_like";
  if (isIobSymbol(i.symbol)) return "iob_line";
  if (isBdrSymbol(i.symbol)) return "bdr_line";
  return null;
}

/** Explicit depositary markers. ADR, ADS and GDR are matched in capitals only so that ordinary words never trigger. */
const DEPOSITARY_ACRONYM = /\b(?:ADR|ADS|GDR)\b/;
const DEPOSITARY_PHRASE = /american depositary|depositary (?:receipt|share)|sponsored/i;

/**
 * Best signal the Yahoo fields we already fetch carry for an ADR/ADS/GDR (A-50). Yahoo has no depositary-receipt flag: quoteType is
 * EQUITY and typeDisp "Equity" for all of them, and names rarely say ADR. So: an explicit name marker, else a trading currency that
 * differs from the financial (reporting) currency. Known errors: an ADR that reports in the trading currency (Equinor, Anheuser-Busch,
 * Arm, argenx report in USD) is read as an ordinary share; an ordinary share that reports in a foreign currency (Spotify, EUR on NYSE) is
 * read as an ADR.
 */
export function isLikelyDepositaryReceipt(i: {
  name: string | null;
  currencyMajor: string | null | undefined;
  financialCurrency: string | null | undefined;
}): boolean {
  if (i.name !== null && (DEPOSITARY_ACRONYM.test(i.name) || DEPOSITARY_PHRASE.test(i.name)))
    return true;
  const trading = i.currencyMajor ?? null;
  const reporting = i.financialCurrency ?? null;
  return trading !== null && reporting !== null && trading !== reporting;
}
