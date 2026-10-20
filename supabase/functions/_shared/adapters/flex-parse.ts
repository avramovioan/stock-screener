// Tolerant, fail-closed parser for an Activity Flex Query statement (spec 12.5, A-37). The XML element and attribute spellings are
// UNVERIFIED (the guide documents labels only): attribute lookup is case-insensitive with an alias table, both attributeNamePrefix
// variants work, and unknown attributes are kept in `raw` (never stored: spec 12.10). P5-01 pins the spellings against a real statement.
import { XMLParser, XMLValidator } from "npm:fast-xml-parser@5.11.2";
import { type CashCategory, categorizeCashType } from "./cash-types.ts";

/** Statements never need a DTD: `<!DOCTYPE` / `<!ENTITY` (entity expansion, XXE) are rejected before parsing. */
export function containsDtd(xml: string): boolean {
  return /<!\s*(DOCTYPE|ENTITY)/i.test(xml);
}

export type Attrs = Record<string, string>;

export interface ParseIssue {
  section: string;
  row: number;
  field: string;
}

export interface FlexPosition {
  conid: number;
  symbol: string;
  isin: string | null;
  description: string | null;
  assetClass: string | null;
  subCategory: string | null;
  listingExchange: string | null;
  currency: string;
  fxRateToBase: number | null;
  quantity: number;
  multiplier: number;
  markPrice: number | null;
  positionValue: number | null;
  openPrice: number | null;
  costBasisPrice: number | null;
  costBasisMoney: number | null;
  fifoPnlUnrealized: number | null;
  percentOfNav: number | null;
  levelOfDetail: string;
  reportDate: string;
  openDateTime: string | null;
  raw: Record<string, string>;
}

export interface FlexTrade {
  tradeId: string | null;
  execId: string;
  orderId: string | null;
  conid: number;
  isin: string | null;
  symbol: string;
  description: string | null;
  listingExchange: string | null;
  exchange: string | null;
  currency: string;
  fxRateToBase: number | null;
  tradeDate: string;
  tradeTime: string | null;
  settleDate: string | null;
  buySell: "BUY" | "SELL";
  quantity: number;
  tradePrice: number;
  tradeMoney: number | null;
  proceeds: number | null;
  taxes: number | null;
  ibCommission: number | null;
  ibCommissionCurrency: string | null;
  netCash: number | null;
  costBasis: number | null;
  fifoPnlRealized: number | null;
  openClose: string | null;
  orderType: string | null;
  reportDate: string | null;
  raw: Record<string, string>;
}

export interface FlexClosedLot {
  conid: number;
  symbol: string;
  currency: string;
  fxRateToBase: number | null;
  openDateTime: string | null;
  closeDate: string;
  closingTradeId: string | null;
  quantity: number;
  costBasis: number;
  proceeds: number | null;
  fifoPnlRealized: number;
  raw: Record<string, string>;
}

export interface FlexCashTransaction {
  occurredAt: string;
  reportDate: string | null;
  currency: string;
  fxRateToBase: number | null;
  amount: number;
  typeRaw: string;
  category: CashCategory;
  conid: number | null;
  isin: string | null;
  symbol: string | null;
  description: string | null;
  tradeId: string | null;
  code: string | null;
  raw: Record<string, string>;
}

export interface FlexFxRate {
  rateDate: string;
  fromCcy: string;
  toCcy: string;
  rate: number;
}
export interface FlexNav {
  reportDate: string;
  currency: string;
  cash: number | null;
  stock: number | null;
  other: number | null;
  total: number;
}

export interface FlexCorporateAction {
  kind: "corporate_action" | "transfer";
  occurredAt: string | null;
  conid: number | null;
  symbol: string | null;
  typeRaw: string | null;
  quantity: number | null;
  amount: number | null;
  currency: string | null;
  code: string | null;
  raw: Record<string, string>;
}

export interface FlexDividendAccrual {
  exDate: string | null;
  payDate: string | null;
  conid: number | null;
  symbol: string | null;
  currency: string | null;
  quantity: number | null;
  grossRate: number | null;
  grossAmount: number | null;
  tax: number | null;
  netAmount: number | null;
  raw: Record<string, string>;
}

export interface FlexInstrument {
  conid: number;
  symbol: string;
  isin: string | null;
  subCategory: string | null;
  listingExchange: string | null;
  description: string | null;
  raw: Record<string, string>;
}

export type SectionKey =
  | "accountInformation"
  | "openPositions"
  | "trades"
  | "cashTransactions"
  | "conversionRates"
  | "nav"
  | "corporateActions"
  | "transfers"
  | "dividendAccruals"
  | "financialInstruments";

export interface FlexStatement {
  accountId: string;
  baseCurrency: string;
  accountType: string | null;
  fromDate: string;
  toDate: string;
  whenGenerated: string | null;
  positions: FlexPosition[];
  trades: FlexTrade[];
  closedLots: FlexClosedLot[];
  cashTransactions: FlexCashTransaction[];
  fxRates: FlexFxRate[];
  nav: FlexNav[];
  corporateActions: FlexCorporateAction[];
  transfers: FlexCorporateAction[];
  dividendAccruals: FlexDividendAccrual[];
  instruments: FlexInstrument[];
  /** which section containers exist in the file (an empty container is present) */
  sections: Record<SectionKey, boolean>;
  /** lower-cased attribute names seen per section, for the field checklist */
  attributesSeen: Record<SectionKey, string[]>;
  /** rows skipped because of their level of detail, e.g. "positions:LOT" */
  ignored: Record<string, number>;
  warnings: string[];
}

export type ParseResult =
  | { ok: true; statement: FlexStatement }
  | {
      ok: false;
      code: "invalid_xml" | "no_statement" | "multiple_statements" | "parse_error";
      message: string;
      issues: ParseIssue[];
    };

export interface ParseOptions {
  attributeNamePrefix?: string;
}

// ------------------------------------------------------------------------------------------------ scalar parsing

export function parseDecimal(input: string | null): number | null {
  if (input === null) return null;
  let s = input.trim().replace(/\s/g, "");
  if (s === "" || s === "-") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^\+/, "");
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastDot > lastComma) s = s.replace(/,/g, "");
    else s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
    else if ((s.match(/,/g) ?? []).length === 1) s = s.replace(",", ".");
    else return null;
  } else if ((s.match(/\./g) ?? []).length > 1) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    else return null;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function validIso(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > last ? null : `${y}-${m}-${d}`;
}

/** Accepts `yyyyMMdd` and `yyyy-MM-dd` (also as the date part of a date/time). `dd/MM/yyyy` and `MM/dd/yyyy` are ambiguous and rejected. */
export function parseFlexDate(input: string | null): string | null {
  if (input === null) return null;
  const head = input.trim().split(/[;,T ]/)[0] ?? "";
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(head) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  return m === null ? null : validIso(m[1] as string, m[2] as string, m[3] as string);
}

export function parseFlexDateTime(
  input: string | null,
): { date: string; time: string | null } | null {
  if (input === null) return null;
  const s = input.trim();
  const date = parseFlexDate(s);
  if (date === null) return null;
  const parts = s.split(/[;,T ]+/);
  const rawTime = parts[1];
  if (rawTime === undefined || rawTime === "") return { date, time: null };
  const m = /^(\d{2}):?(\d{2}):?(\d{2})$/.exec(rawTime);
  if (m === null || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59)
    return { date, time: null };
  return { date, time: `${m[1]}:${m[2]}:${m[3]}` };
}

const stamp = (dt: { date: string; time: string | null }): string =>
  `${dt.date}T${dt.time ?? "00:00:00"}Z`;

// ------------------------------------------------------------------------------------------------ XML access

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

const stripPrefix = (k: string): string =>
  k.startsWith("@_") ? k.slice(2) : k.startsWith("@") ? k.slice(1) : k;

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decodes the five predefined XML entities and numeric character references in one pass, so `&amp;amp;` becomes `&amp;`.
 * Unknown names and out-of-range or non-character references are left as written. The parser keeps `processEntities: false`,
 * so nothing declared in a DTD is ever expanded.
 */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return PREDEFINED_ENTITIES[body] ?? whole;
  });
}

function toAttrs(node: unknown): { attrs: Attrs; raw: Record<string, string> } {
  const attrs: Attrs = {};
  const raw: Record<string, string> = {};
  if (typeof node !== "object" || node === null) return { attrs, raw };
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!isPrimitive(v) || k === "#text") continue;
    const name = stripPrefix(k);
    const value = decodeXmlEntities(String(v));
    raw[name] = value;
    attrs[name.toLowerCase()] = value;
  }
  return { attrs, raw };
}

function pick(a: Attrs, ...names: string[]): string | null {
  for (const name of names) {
    const v = a[name.toLowerCase()];
    if (v === undefined) continue;
    const t = v.trim();
    if (t !== "" && t !== "-" && t.toUpperCase() !== "N/A") return t;
  }
  return null;
}

function findKey(node: unknown, names: readonly string[]): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  return Object.keys(node).find((k) => names.includes(k.toLowerCase()));
}

function child(node: unknown, names: readonly string[]): unknown {
  const key = findKey(node, names);
  return key === undefined ? undefined : (node as Record<string, unknown>)[key];
}

interface Row {
  element: string;
  attrs: Attrs;
  raw: Record<string, string>;
}

function rowsOf(container: unknown): Row[] {
  if (typeof container !== "object" || container === null) return [];
  const out: Row[] = [];
  for (const [element, value] of Object.entries(container as Record<string, unknown>)) {
    if (isPrimitive(value)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "object" && item !== null) out.push({ element, ...toAttrs(item) });
    }
  }
  return out;
}

const CONTAINERS: Record<SectionKey, readonly string[]> = {
  accountInformation: ["accountinformation"],
  openPositions: ["openpositions"],
  trades: ["trades"],
  cashTransactions: ["cashtransactions"],
  conversionRates: ["conversionrates"],
  nav: ["equitysummaryinbase", "netassetvalueinbase", "navsummaryinbase"],
  corporateActions: ["corporateactions"],
  transfers: ["transfers"],
  dividendAccruals: ["changeindividendaccruals"],
  // IBKR names the section "SecuritiesInfo" with "SecurityInfo" rows; the old name is kept for synthetic data
  financialInstruments: ["securitiesinfo", "financialinstrumentinformation"],
};

const SECTION_KEYS = Object.keys(CONTAINERS) as SectionKey[];

// ------------------------------------------------------------------------------------------------ parse

class Ctx {
  readonly issues: ParseIssue[] = [];
  section = "";
  row = 0;
  issue(field: string): void {
    this.issues.push({ section: this.section, row: this.row, field });
  }
  str(a: Attrs, field: string, ...names: string[]): string {
    const v = pick(a, ...names);
    if (v === null) this.issue(field);
    return v ?? "";
  }
  num(a: Attrs, field: string, ...names: string[]): number {
    const n = parseDecimal(pick(a, ...names));
    if (n === null) this.issue(field);
    return n ?? Number.NaN;
  }
  int(a: Attrs, field: string, ...names: string[]): number {
    const n = parseDecimal(pick(a, ...names));
    if (n === null || !Number.isInteger(n)) this.issue(field);
    return n ?? Number.NaN;
  }
  date(a: Attrs, field: string, ...names: string[]): string {
    const v = pick(a, ...names);
    const d = parseFlexDate(v);
    if (d === null) this.issue(field);
    return d ?? "";
  }
  dateTime(a: Attrs, field: string, ...names: string[]): { date: string; time: string | null } {
    const dt = parseFlexDateTime(pick(a, ...names));
    if (dt === null) this.issue(field);
    return dt ?? { date: "", time: null };
  }
}

const optNum = (a: Attrs, ...names: string[]): number | null => parseDecimal(pick(a, ...names));
const optDate = (a: Attrs, ...names: string[]): string | null => parseFlexDate(pick(a, ...names));
const optInt = (a: Attrs, ...names: string[]): number | null => {
  const n = parseDecimal(pick(a, ...names));
  return n !== null && Number.isInteger(n) ? n : null;
};
const optStamp = (a: Attrs, ...names: string[]): string | null => {
  const dt = parseFlexDateTime(pick(a, ...names));
  return dt === null ? null : stamp(dt);
};

function fail(
  code: "invalid_xml" | "no_statement" | "multiple_statements" | "parse_error",
  message: string,
  issues: ParseIssue[] = [],
): ParseResult {
  return { ok: false, code, message, issues };
}

export function parseFlexStatement(xml: string, opts: ParseOptions = {}): ParseResult {
  if (containsDtd(xml))
    return fail(
      "invalid_xml",
      "The statement contains a DOCTYPE or ENTITY declaration and was rejected.",
    );
  if (XMLValidator.validate(xml) !== true)
    return fail("invalid_xml", "The statement is not well-formed XML.");
  let doc: unknown;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      htmlEntities: false,
      attributeNamePrefix: opts.attributeNamePrefix ?? "@_",
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: true,
      allowBooleanAttributes: true,
      isArray: (name) => name.toLowerCase() === "flexstatement",
    }).parse(xml);
  } catch {
    return fail("invalid_xml", "The statement could not be read as XML.");
  }
  const root = child(doc, ["flexqueryresponse"]);
  const holder = child(root, ["flexstatements"]);
  const list = child(holder, ["flexstatement"]);
  const statements = Array.isArray(list) ? list : list === undefined ? [] : [list];
  if (statements.length === 0)
    return fail("no_statement", "The response contains no FlexStatement.");
  if (statements.length > 1)
    return fail(
      "multiple_statements",
      "The response contains more than one statement; link a query for a single account.",
    );
  const node = statements[0] as Record<string, unknown>;
  const head = toAttrs(node).attrs;

  const c = new Ctx();
  c.section = "statement";
  c.row = 0;
  const accountFromHead = pick(head, "accountId");
  const fromDate = c.date(head, "fromDate", "fromDate");
  const toDate = c.date(head, "toDate", "toDate");
  const whenGenerated = parseFlexDateTime(pick(head, "whenGenerated"));

  const sections = Object.fromEntries(
    SECTION_KEYS.map((k) => [k, findKey(node, CONTAINERS[k]) !== undefined]),
  ) as Record<SectionKey, boolean>;
  const seen: Record<SectionKey, Set<string>> = Object.fromEntries(
    SECTION_KEYS.map((k) => [k, new Set<string>()]),
  ) as Record<SectionKey, Set<string>>;
  const sectionRows = (key: SectionKey): Row[] => {
    const rows = rowsOf(child(node, CONTAINERS[key]));
    for (const r of rows) for (const name of Object.keys(r.attrs)) seen[key].add(name);
    return rows;
  };

  // account information
  const accountNode = child(node, CONTAINERS.accountInformation);
  const account = toAttrs(accountNode).attrs;
  for (const name of Object.keys(account)) seen.accountInformation.add(name);
  c.section = "accountInformation";
  const accountId = pick(account, "accountId") ?? accountFromHead ?? "";
  if (accountId === "") c.issue("accountId");
  const baseCurrency = pick(account, "currency") ?? "";
  if (baseCurrency === "") c.issue("currency");
  const accountType = pick(account, "accountType");

  const ignored: Record<string, number> = {};
  const bump = (key: string) => {
    ignored[key] = (ignored[key] ?? 0) + 1;
  };

  // open positions (SUMMARY level only; LOT rows are counted and skipped)
  const positions: FlexPosition[] = [];
  c.section = "openPositions";
  sectionRows("openPositions").forEach((r, i) => {
    c.row = i + 1;
    const level = (pick(r.attrs, "levelOfDetail") ?? "SUMMARY").toUpperCase();
    if (level !== "SUMMARY") {
      bump(`positions:${level}`);
      return;
    }
    positions.push({
      conid: c.int(r.attrs, "conid", "conid"),
      symbol: c.str(r.attrs, "symbol", "symbol"),
      isin: pick(r.attrs, "isin"),
      description: pick(r.attrs, "description"),
      assetClass: pick(r.attrs, "assetCategory", "assetClass"),
      subCategory: pick(r.attrs, "subCategory"),
      listingExchange: pick(r.attrs, "listingExchange"),
      currency: c.str(r.attrs, "currency", "currency"),
      fxRateToBase: optNum(r.attrs, "fxRateToBase"),
      quantity: c.num(r.attrs, "position", "position", "quantity", "qty"),
      multiplier: optNum(r.attrs, "multiplier") ?? 1,
      markPrice: optNum(r.attrs, "markPrice"),
      positionValue: optNum(r.attrs, "positionValue"),
      openPrice: optNum(r.attrs, "openPrice"),
      costBasisPrice: optNum(r.attrs, "costBasisPrice"),
      costBasisMoney: optNum(r.attrs, "costBasisMoney"),
      fifoPnlUnrealized: optNum(r.attrs, "fifoPnlUnrealized"),
      percentOfNav: optNum(r.attrs, "percentOfNAV", "percentOfNav"),
      levelOfDetail: level,
      reportDate:
        pick(r.attrs, "reportDate") === null ? toDate : c.date(r.attrs, "reportDate", "reportDate"),
      openDateTime: optStamp(r.attrs, "openDateTime"),
      raw: r.raw,
    });
  });

  // trades: executions and closed lots are different levels of detail of the same section
  const trades: FlexTrade[] = [];
  const closedLots: FlexClosedLot[] = [];
  c.section = "trades";
  sectionRows("trades").forEach((r, i) => {
    c.row = i + 1;
    const level = (
      pick(r.attrs, "levelOfDetail") ??
      (r.element.toLowerCase() === "lot" ? "CLOSED_LOT" : "EXECUTION")
    ).toUpperCase();
    if (level === "EXECUTION") {
      const tradeId = pick(r.attrs, "tradeID");
      const exec = pick(r.attrs, "ibExecID");
      if (exec === null && tradeId === null) c.issue("ibExecID|tradeID");
      const side = (pick(r.attrs, "buySell") ?? "").toUpperCase();
      if (side !== "BUY" && side !== "SELL") c.issue("buySell");
      const dt =
        pick(r.attrs, "tradeDate") !== null
          ? undefined
          : c.dateTime(r.attrs, "tradeDate", "dateTime");
      const tradeDate = dt === undefined ? c.date(r.attrs, "tradeDate", "tradeDate") : dt.date;
      const time = pick(r.attrs, "tradeTime");
      const tm =
        time === null
          ? (dt?.time ?? parseFlexDateTime(pick(r.attrs, "dateTime"))?.time ?? null)
          : (/^(\d{2}):?(\d{2}):?(\d{2})$/.exec(time)?.slice(1, 4).join(":") ?? null);
      trades.push({
        tradeId,
        execId: exec ?? `trade:${tradeId ?? ""}`,
        orderId: pick(r.attrs, "ibOrderID"),
        conid: c.int(r.attrs, "conid", "conid"),
        isin: pick(r.attrs, "isin"),
        symbol: c.str(r.attrs, "symbol", "symbol"),
        description: pick(r.attrs, "description"),
        listingExchange: pick(r.attrs, "listingExchange"),
        exchange: pick(r.attrs, "exchange"),
        currency: c.str(r.attrs, "currency", "currency"),
        fxRateToBase: optNum(r.attrs, "fxRateToBase"),
        tradeDate,
        tradeTime: tm,
        settleDate: optDate(r.attrs, "settleDateTarget", "settleDate"),
        buySell: side === "SELL" ? "SELL" : "BUY",
        quantity: c.num(r.attrs, "quantity", "quantity"),
        tradePrice: c.num(r.attrs, "tradePrice", "tradePrice"),
        tradeMoney: optNum(r.attrs, "tradeMoney"),
        proceeds: optNum(r.attrs, "proceeds"),
        taxes: optNum(r.attrs, "taxes"),
        ibCommission: optNum(r.attrs, "ibCommission"),
        ibCommissionCurrency: pick(r.attrs, "ibCommissionCurrency"),
        netCash: optNum(r.attrs, "netCash"),
        costBasis: optNum(r.attrs, "costBasis", "cost"),
        fifoPnlRealized: optNum(r.attrs, "fifoPnlRealized"),
        openClose: pick(r.attrs, "openCloseIndicator"),
        orderType: pick(r.attrs, "orderType"),
        reportDate: optDate(r.attrs, "reportDate"),
        raw: r.raw,
      });
    } else if (level === "CLOSED_LOT") {
      const closeDate = parseFlexDate(pick(r.attrs, "tradeDate", "dateTime", "reportDate"));
      if (closeDate === null) c.issue("tradeDate");
      closedLots.push({
        conid: c.int(r.attrs, "conid", "conid"),
        symbol: c.str(r.attrs, "symbol", "symbol"),
        currency: c.str(r.attrs, "currency", "currency"),
        fxRateToBase: optNum(r.attrs, "fxRateToBase"),
        openDateTime: optStamp(r.attrs, "openDateTime"),
        closeDate: closeDate ?? "",
        closingTradeId: pick(r.attrs, "tradeID"),
        quantity: Math.abs(c.num(r.attrs, "quantity", "quantity")),
        costBasis: c.num(r.attrs, "costBasis", "costBasis", "cost"),
        proceeds: optNum(r.attrs, "proceeds"),
        fifoPnlRealized: c.num(r.attrs, "fifoPnlRealized", "fifoPnlRealized"),
        raw: r.raw,
      });
    } else {
      bump(`trades:${level}`);
    }
  });

  // cash transactions
  const cash: FlexCashTransaction[] = [];
  c.section = "cashTransactions";
  sectionRows("cashTransactions").forEach((r, i) => {
    c.row = i + 1;
    const when = c.dateTime(r.attrs, "dateTime", "dateTime", "date", "reportDate");
    const typeRaw = c.str(r.attrs, "type", "type");
    cash.push({
      occurredAt: stamp(when),
      reportDate: optDate(r.attrs, "reportDate"),
      currency: c.str(r.attrs, "currency", "currency"),
      fxRateToBase: optNum(r.attrs, "fxRateToBase"),
      amount: c.num(r.attrs, "amount", "amount"),
      typeRaw,
      category: categorizeCashType(typeRaw),
      conid: optInt(r.attrs, "conid"),
      isin: pick(r.attrs, "isin"),
      symbol: pick(r.attrs, "symbol"),
      description: pick(r.attrs, "description"),
      tradeId: pick(r.attrs, "tradeID"),
      code: pick(r.attrs, "code"),
      raw: r.raw,
    });
  });

  // currency conversion rates
  const fxRates: FlexFxRate[] = [];
  c.section = "conversionRates";
  sectionRows("conversionRates").forEach((r, i) => {
    c.row = i + 1;
    fxRates.push({
      rateDate: c.dateTime(r.attrs, "reportDate", "reportDate", "date", "dateTime").date,
      fromCcy: c.str(r.attrs, "fromCurrency", "fromCurrency"),
      toCcy: c.str(r.attrs, "toCurrency", "toCurrency"),
      rate: c.num(r.attrs, "rate", "rate"),
    });
  });

  // NAV summary in base
  const nav: FlexNav[] = [];
  c.section = "nav";
  sectionRows("nav").forEach((r, i) => {
    c.row = i + 1;
    const parts = ["options", "bonds", "interestAccruals", "dividendAccruals"].map((n) =>
      optNum(r.attrs, n),
    );
    const present = parts.filter((p): p is number => p !== null);
    nav.push({
      reportDate: c.date(r.attrs, "reportDate", "reportDate"),
      currency: pick(r.attrs, "currency") ?? baseCurrency,
      cash: optNum(r.attrs, "cash"),
      stock: optNum(r.attrs, "stock"),
      other:
        present.length === 0 ? null : Math.round(present.reduce((a, b) => a + b, 0) * 1e8) / 1e8,
      total: c.num(r.attrs, "total", "total"),
    });
  });

  // corporate actions and transfers (coverage disclosure only)
  const mapAction =
    (kind: "corporate_action" | "transfer") =>
    (r: Row): FlexCorporateAction => ({
      kind,
      occurredAt: optStamp(r.attrs, "dateTime", "date", "reportDate"),
      conid: optInt(r.attrs, "conid"),
      symbol: pick(r.attrs, "symbol"),
      typeRaw: pick(r.attrs, "type"),
      quantity: optNum(r.attrs, "quantity"),
      amount: optNum(r.attrs, "amount", "positionAmount"),
      currency: pick(r.attrs, "currency"),
      code: pick(r.attrs, "code"),
      raw: r.raw,
    });
  const corporateActions = sectionRows("corporateActions").map(mapAction("corporate_action"));
  const transfers = sectionRows("transfers").map(mapAction("transfer"));

  const dividendAccruals: FlexDividendAccrual[] = sectionRows("dividendAccruals").map((r) => ({
    exDate: optDate(r.attrs, "exDate"),
    payDate: optDate(r.attrs, "payDate"),
    conid: optInt(r.attrs, "conid"),
    symbol: pick(r.attrs, "symbol"),
    currency: pick(r.attrs, "currency"),
    quantity: optNum(r.attrs, "quantity"),
    grossRate: optNum(r.attrs, "grossRate"),
    grossAmount: optNum(r.attrs, "grossAmount"),
    tax: optNum(r.attrs, "tax"),
    netAmount: optNum(r.attrs, "netAmount"),
    raw: r.raw,
  }));

  const instruments: FlexInstrument[] = [];
  sectionRows("financialInstruments").forEach((r) => {
    const conid = optInt(r.attrs, "conid");
    const symbol = pick(r.attrs, "symbol");
    if (conid === null || symbol === null) {
      bump("instruments:incomplete");
      return;
    }
    instruments.push({
      conid,
      symbol,
      isin: pick(r.attrs, "isin"),
      subCategory: pick(r.attrs, "subCategory"),
      listingExchange: pick(r.attrs, "listingExchange"),
      description: pick(r.attrs, "description"),
      raw: r.raw,
    });
  });

  if (c.issues.length > 0) {
    const first = c.issues[0] as ParseIssue;
    return fail(
      "parse_error",
      `${c.issues.length} required value(s) missing or unreadable, first: ${first.section} row ${first.row} ${first.field}.`,
      c.issues.slice(0, 50),
    );
  }

  // Open Positions carries no listing exchange or sub-category: Financial Instrument Information supplies them (research flex 2.2)
  const byConid = new Map(instruments.map((i) => [i.conid, i]));
  for (const p of positions) {
    const info = byConid.get(p.conid);
    if (info === undefined) continue;
    p.subCategory ??= info.subCategory;
    p.listingExchange ??= info.listingExchange;
    p.isin ??= info.isin;
    p.description ??= info.description;
  }
  for (const t of trades) {
    const info = byConid.get(t.conid);
    if (info === undefined) continue;
    t.listingExchange ??= info.listingExchange;
    t.isin ??= info.isin;
  }

  const warnings: string[] = [];
  if (
    closedLots.length === 0 &&
    trades.some((t) => t.fifoPnlRealized !== null && t.fifoPnlRealized !== 0)
  )
    warnings.push("closed_lots_not_included");

  return {
    ok: true,
    statement: {
      accountId,
      baseCurrency,
      accountType,
      fromDate,
      toDate,
      whenGenerated: whenGenerated === null ? null : stamp(whenGenerated),
      positions,
      trades,
      closedLots,
      cashTransactions: cash,
      fxRates,
      nav,
      corporateActions,
      transfers,
      dividendAccruals,
      instruments,
      sections,
      attributesSeen: Object.fromEntries(
        SECTION_KEYS.map((k) => [k, [...seen[k]].sort()]),
      ) as Record<SectionKey, string[]>,
      ignored,
      warnings,
    },
  };
}

// ------------------------------------------------------------------------------------------------ link verification (spec 12.3)

export interface SectionReport {
  section: string;
  present: boolean;
  missingFields: string[];
}

const REQUIRED: Array<{ key: SectionKey; label: string; fields: Array<[string, string[]]> }> = [
  {
    key: "accountInformation",
    label: "Account Information",
    fields: [
      ["Account ID", ["accountid"]],
      ["Currency", ["currency"]],
    ],
  },
  {
    key: "openPositions",
    label: "Open Positions",
    fields: [
      ["Currency", ["currency"]],
      ["Asset Class", ["assetcategory", "assetclass"]],
      ["FX Rate to Base", ["fxratetobase"]],
      ["Symbol", ["symbol"]],
      ["Conid", ["conid"]],
      ["ISIN", ["isin"]],
      ["Report Date", ["reportdate"]],
      ["Quantity", ["position", "quantity"]],
      ["Mark Price", ["markprice"]],
      ["Position Value", ["positionvalue"]],
      ["Cost Basis Price", ["costbasisprice"]],
      ["Cost Basis Money", ["costbasismoney"]],
      ["FIFO Unrealized PNL", ["fifopnlunrealized"]],
      ["Level of Detail", ["levelofdetail"]],
    ],
  },
  {
    key: "trades",
    label: "Trades",
    fields: [
      ["Currency", ["currency"]],
      ["FX Rate to Base", ["fxratetobase"]],
      ["Symbol", ["symbol"]],
      ["Conid", ["conid"]],
      ["Trade ID", ["tradeid"]],
      ["Trade Date", ["tradedate"]],
      ["Quantity", ["quantity"]],
      ["Trade Price", ["tradeprice"]],
      ["IB Commission", ["ibcommission"]],
      ["IB Commission Currency", ["ibcommissioncurrency"]],
      ["Buy/Sell", ["buysell"]],
      ["IB Order ID", ["iborderid"]],
      ["IB Execution ID", ["ibexecid"]],
      ["Net Cash", ["netcash"]],
      ["Realized PNL", ["fifopnlrealized"]],
      ["Level of Detail", ["levelofdetail"]],
    ],
  },
  {
    key: "cashTransactions",
    label: "Cash Transactions",
    fields: [
      ["Currency", ["currency"]],
      ["FX Rate to Base", ["fxratetobase"]],
      ["Date/Time", ["datetime"]],
      ["Amount", ["amount"]],
      ["Type", ["type"]],
    ],
  },
  {
    key: "conversionRates",
    label: "Currency Conversion Rate",
    fields: [
      ["Date/Time", ["reportdate", "date", "datetime"]],
      ["From Currency", ["fromcurrency"]],
      ["To Currency", ["tocurrency"]],
      ["Rate", ["rate"]],
    ],
  },
  {
    key: "financialInstruments",
    label: "Financial Instrument Information",
    fields: [
      ["Symbol", ["symbol"]],
      ["Conid", ["conid"]],
      ["Subcategory", ["subcategory"]],
      ["Listing Exchange", ["listingexchange"]],
      ["ISIN", ["isin"]],
    ],
  },
];

/** Which required sections and fields are present; a field is missing when no row of its section carries any alias of it. */
export function requiredSectionReport(s: FlexStatement): SectionReport[] {
  return REQUIRED.map((req) => {
    const present = s.sections[req.key];
    const seen = new Set(s.attributesSeen[req.key]);
    const hasRows = seen.size > 0;
    const missingFields =
      present && hasRows
        ? req.fields
            .filter(([, aliases]) => !aliases.some((a) => seen.has(a)))
            .map(([label]) => label)
        : [];
    return { section: req.label, present, missingFields };
  });
}
