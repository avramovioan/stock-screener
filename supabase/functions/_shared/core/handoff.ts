// "Trade on IBKR" hand-off (spec 13). Pure: builds text for the owner to paste into IBKR's iBot. The app never places an order.
// Rules: relative ".ts" imports only, no Date.now(), no Intl, no locale-dependent formatting (a decimal comma must never reach a prompt).

export type Destination = "IBIS2" | "IBIS" | "AEB";
export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type EurExchange = "IBIS" | "AEB";
export type EurStatus = "verified" | "unverified" | "none";

export const DESTINATIONS: readonly Destination[] = ["IBIS2", "IBIS", "AEB"];
export const DEFAULT_DESTINATION: Destination = "IBIS2";

export const DESTINATION_LABELS: Readonly<Record<Destination, string>> = {
  IBIS2: "Xetra (IBIS2 — owner practice, not in IBKR's public catalogue)",
  IBIS: "Xetra",
  AEB: "Euronext Amsterdam",
};

export const IBKR_LOGIN_URL = "https://www.interactivebrokers.com/sso/Login";
export const NO_ORDER_NOTICE =
  "This app does not place orders. Paste the prompt into IBKR's iBot or create the order yourself, then confirm it in IBKR.";
export const TICKET_REVIEW_NOTE =
  "iBot prepares an order ticket for your review. Check the instrument (conid and EUR currency), destination, quantity and price, then submit it yourself in IBKR.";

export const MAX_PRICE_DECIMALS = 4;
const MAX_PRICE = 1_000_000_000;
const MAX_QUANTITY = 1_000_000_000;
/** IBKR local symbols on IBIS and AEB are upper-case letters and digits; a dot is allowed (share-class style symbols). */
const LOCAL_SYMBOL = /^[A-Z0-9][A-Z0-9.]{0,11}$/;

export function isDestination(value: unknown): value is Destination {
  return typeof value === "string" && (DESTINATIONS as readonly string[]).includes(value);
}

/** The Yahoo suffixes of the two venues this feature maps (`MSF.DE`, `UNA.AS`). IBKR local symbols on IBIS and AEB never carry them. */
const YAHOO_SUFFIX = /\.(DE|AS)$/;

/** Why a string cannot be used as the IBKR local symbol in a prompt, or null when it can. A Yahoo ticker is the classic wrong input. */
export function localSymbolProblem(value: string): string | null {
  if (YAHOO_SUFFIX.test(value)) {
    const base = value.replace(YAHOO_SUFFIX, "");
    return `That looks like a Yahoo ticker (${value}). Use the IBKR local symbol (${base}).`;
  }
  if (!LOCAL_SYMBOL.test(value) || value.endsWith(".")) {
    return "The IBKR local symbol must use upper-case letters, digits and dots only.";
  }
  return null;
}

export function isValidLocalSymbol(value: string): boolean {
  return localSymbolProblem(value) === null;
}

// ---------------------------------------------------------------------------------------------- prompt

export interface IbotInput {
  side: Side;
  orderType: OrderType;
  quantity: number;
  localSymbol: string;
  price?: number | undefined;
  destination: Destination;
}

export type IssueField =
  | "side"
  | "orderType"
  | "quantity"
  | "localSymbol"
  | "price"
  | "destination";
export interface PromptIssue {
  field: IssueField;
  code: string;
  message: string;
}
export type PromptResult = { ok: true; prompt: string } | { ok: false; issues: PromptIssue[] };
export type DocumentedPromptResult =
  | { ok: true; prompt: string; ticketNote: string }
  | { ok: false; issues: PromptIssue[] };

/** The price exactly as it appears in a prompt: dot decimal separator, at most 4 decimals, no grouping, no exponent. */
export function formatPriceForPrompt(price: number): string {
  return String(Number(price.toFixed(MAX_PRICE_DECIMALS)));
}

export function validateIbotInput(input: IbotInput): PromptIssue[] {
  const issues: PromptIssue[] = [];
  const add = (field: IssueField, code: string, message: string) =>
    issues.push({ field, code, message });
  if (input.side !== "buy" && input.side !== "sell") add("side", "invalid", "Choose buy or sell.");
  if (input.orderType !== "limit" && input.orderType !== "market")
    add("orderType", "invalid", "Choose limit or market.");
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity <= 0 ||
    input.quantity > MAX_QUANTITY
  ) {
    add("quantity", "not_positive_integer", "Quantity must be a positive whole number.");
  }
  const symbolProblem = localSymbolProblem(input.localSymbol);
  if (symbolProblem !== null) {
    add(
      "localSymbol",
      YAHOO_SUFFIX.test(input.localSymbol) ? "yahoo_suffix" : "invalid_format",
      symbolProblem,
    );
  }
  if (!isDestination(input.destination))
    add("destination", "invalid", "Choose IBIS2, IBIS or AEB.");
  if (input.orderType === "limit") {
    const p = input.price;
    if (p === undefined || !Number.isFinite(p) || p <= 0 || p > MAX_PRICE) {
      add("price", "not_positive_number", "A limit order needs a price greater than zero.");
    } else if (Number(p.toFixed(MAX_PRICE_DECIMALS)) !== p) {
      add("price", "too_many_decimals", `Use at most ${MAX_PRICE_DECIMALS} decimals.`);
    }
  }
  return issues;
}

/** Owner's template (D5): `Create <buy|sell> <limit|market> order for <qty> shares of <local symbol> at <price> and set destination <dest>`.
 *  A market order has no `at <price>` clause (A-38). The template says "shares" for every quantity, including 1. */
export function buildIbotPrompt(input: IbotInput): PromptResult {
  const issues = validateIbotInput(input);
  if (issues.length > 0) return { ok: false, issues };
  const at =
    input.orderType === "limit" ? ` at ${formatPriceForPrompt(input.price as number)}` : "";
  return {
    ok: true,
    prompt: `Create ${input.side} ${input.orderType} order for ${input.quantity} shares of ${input.localSymbol}${at} and set destination ${input.destination}`,
  };
}

/** Second, collapsible variant (spec 13.2): the grammar IBKR documents for iBot, with the destination moved to a ticket note. */
export function buildDocumentedStylePrompt(input: IbotInput): DocumentedPromptResult {
  const issues = validateIbotInput(input);
  if (issues.length > 0) return { ok: false, issues };
  const verb = input.side === "buy" ? "Buy" : "Sell";
  const tail =
    input.orderType === "limit"
      ? `at ${formatPriceForPrompt(input.price as number)} limit`
      : "at market";
  return {
    ok: true,
    prompt: `${verb} ${input.quantity} shares of ${input.localSymbol} ${tail}`,
    ticketNote: `On the ticket set the destination to ${input.destination}.`,
  };
}

// ---------------------------------------------------------------------------------------------- field parsing (UI text -> number)

export type ParseResult = { ok: true; value: number } | { ok: false; message: string };

/** A price typed by the user. A comma is rejected, never "fixed": 472,85 could be 472.85 or 47285 and a wrong guess costs money. */
export function parsePriceInput(text: string): ParseResult {
  const t = text.trim();
  if (t === "") return { ok: false, message: "Enter a price." };
  if (/[,\s]/.test(t))
    return {
      ok: false,
      message: "Use a dot as the decimal separator (472.85) and no thousands separators.",
    };
  if (!/^\d+(\.\d{1,4})?$/.test(t))
    return {
      ok: false,
      message: `Enter a positive number with at most ${MAX_PRICE_DECIMALS} decimals.`,
    };
  const value = Number(t);
  if (!(value > 0) || value > MAX_PRICE)
    return { ok: false, message: "The price must be greater than zero." };
  return { ok: true, value };
}

export function parseQuantityInput(text: string): ParseResult {
  const t = text.trim();
  if (t === "") return { ok: false, message: "Enter a quantity." };
  if (!/^[1-9]\d{0,8}$/.test(t))
    return { ok: false, message: "Quantity must be a positive whole number." };
  return { ok: true, value: Number(t) };
}

// ---------------------------------------------------------------------------------------------- EUR listing choice and destinations

export interface EurListing {
  exchange: EurExchange;
  status: EurStatus;
  conid: number | null;
  localSymbol: string | null;
  isin: string | null;
  eurSymbolYahoo: string | null;
  verifiedAt: string | null;
  verification: Record<string, unknown>;
}

const STATUS_RANK: Record<EurStatus, number> = { verified: 0, unverified: 1, none: 2 };
const EXCHANGE_RANK: Record<EurExchange, number> = { IBIS: 0, AEB: 1 };

const isOverride = (r: EurListing): number => (r.verification.override === true ? 0 : 1);

/** Best EUR line for a security: an operator override first (it wins across exchanges), then verified before unverified before none, then IBIS (Xetra) before AEB (spec 5.7, brief 21). */
export function pickListing(rows: readonly EurListing[]): EurListing | null {
  const sorted = [...rows].sort(
    (a, b) =>
      isOverride(a) - isOverride(b) ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      EXCHANGE_RANK[a.exchange] - EXCHANGE_RANK[b.exchange],
  );
  return sorted[0] ?? null;
}

/** Destinations that make sense for the exchanges that actually list the instrument (spec 13.3). No listing at all: the manual path allows all three. */
export function allowedDestinations(exchanges: readonly EurExchange[]): Destination[] {
  if (exchanges.length === 0) return [...DESTINATIONS];
  const out: Destination[] = [];
  if (exchanges.includes("IBIS")) out.push("IBIS2", "IBIS");
  if (exchanges.includes("AEB")) out.push("AEB");
  return out;
}

export function chooseDestination(
  preferred: Destination,
  exchanges: readonly EurExchange[],
): { destination: Destination; adjusted: boolean; reason: string | null } {
  const allowed = allowedDestinations(exchanges);
  if (allowed.includes(preferred)) return { destination: preferred, adjusted: false, reason: null };
  const destination = allowed[0] ?? preferred;
  return {
    destination,
    adjusted: true,
    reason: `Your default destination ${preferred} does not apply to this instrument (${DESTINATION_LABELS[destination]} is the venue that lists it); ${destination} is pre-selected.`,
  };
}

// ---------------------------------------------------------------------------------------------- modal summary

function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Display only (never used in a prompt): 4728.5 -> "4,728.50". */
export function formatEuro(amount: number): string {
  const fixed = Math.abs(amount).toFixed(2);
  const [int = "0", frac = "00"] = fixed.split(".");
  return `${amount < 0 ? "-" : ""}${groupThousands(int)}.${frac}`;
}

export interface EstimateInput {
  orderType: OrderType;
  quantity: number;
  price?: number | undefined;
  referencePrice?: number | null | undefined;
}
export interface Estimate {
  amount: number | null;
  basis: "limit price" | "delayed quote" | null;
  label: string;
}

/** "Value before fees: quantity x limit price" (spec 13.1). No commission is estimated (no IBKR source). Always labelled an estimate. */
export function estimateValue(input: EstimateInput): Estimate {
  const usable = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  let unit: number | null = null;
  let basis: Estimate["basis"] = null;
  if (input.orderType === "limit" && usable(input.price)) {
    unit = input.price;
    basis = "limit price";
  } else if (input.orderType === "market" && usable(input.referencePrice)) {
    unit = input.referencePrice;
    basis = "delayed quote";
  }
  if (unit === null || !Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    return { amount: null, basis: null, label: "Estimate before fees: not available" };
  }
  const amount = Math.round(input.quantity * unit * 100) / 100;
  return {
    amount,
    basis,
    label: `Estimate before fees: ${formatEuro(amount)} EUR (${input.quantity} x ${formatPriceForPrompt(unit)}, ${basis}); commissions not included`,
  };
}

/** "On the ticket confirm: conid 12178239 / MSF / EUR / destination IBIS2" (spec 13.1). */
export function ticketChecklist(input: {
  conid: number | null;
  localSymbol: string;
  destination: Destination;
}): string {
  const conid =
    input.conid === null ? "conid unknown (symbol not verified)" : `conid ${input.conid}`;
  return `On the ticket confirm: ${conid} / ${input.localSymbol} / EUR / destination ${input.destination}`;
}
