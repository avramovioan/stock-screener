import { displayTicker } from "@core/ticker.ts";
import { resolveCurrency } from "@core/units.ts";

const NA = "n/a";
const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

const price2 = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const priceSmall = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const integer = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/**
 * Price with the currency CODE as text (never a symbol): "412.50 USD".
 * `minor: true` means `value` is in minor units (GBp, ZAc, ILA, KWF): it is converted to the
 * major currency using `@core/units.ts`. Default: shown exactly as quoted ("1,234.50 GBp").
 * `null`, `undefined` and NaN are "n/a"; zero is a real value.
 */
export function formatMoney(
  value: number | null | undefined,
  ccy: string,
  opts: { minor?: boolean } = {},
): string {
  if (!isNum(value)) return NA;
  let v = value;
  let code = ccy;
  if (opts.minor) {
    const unit = resolveCurrency(ccy);
    if (unit.divisor !== 1) {
      v = value / unit.divisor;
      code = unit.major;
    }
  }
  const fmt = v !== 0 && Math.abs(v) < 1 ? priceSmall : price2;
  const text = fmt.format(v).replace(/^-(0(?:\.0+)?)$/, "$1"); // never "-0.00"
  return `${text} ${code}`;
}

/**
 * Currencies the Overview shows with a symbol. "narrowSymbol" is the bare symbol Intl gives ($, €, £, ¥, ₹, ₩, R$);
 * "symbol" is the Intl form that stays unambiguous on one page (CA$, A$, HK$, NT$, MX$, CN¥, "SEK 1.00"). `symbol` overrides
 * what Intl prints (SGD has no short symbol in en-US). Only USD is a bare "$"; ¥ is the yen only.
 */
const SYMBOL_CURRENCIES: Readonly<
  Record<string, { display: "narrowSymbol" | "symbol"; symbol?: string }>
> = {
  USD: { display: "narrowSymbol" },
  EUR: { display: "narrowSymbol" },
  GBP: { display: "narrowSymbol" },
  JPY: { display: "narrowSymbol" },
  INR: { display: "narrowSymbol" },
  KRW: { display: "narrowSymbol" },
  BRL: { display: "narrowSymbol" },
  CHF: { display: "symbol" },
  CNY: { display: "symbol" },
  HKD: { display: "symbol" },
  CAD: { display: "symbol" },
  AUD: { display: "symbol" },
  TWD: { display: "symbol" },
  SGD: { display: "symbol", symbol: "S$" },
  SEK: { display: "symbol" },
  NOK: { display: "symbol" },
  DKK: { display: "symbol" },
  MXN: { display: "symbol" },
  SAR: { display: "symbol" },
};

const symbolFormatters = new Map<string, Intl.NumberFormat>();
function symbolFormatter(ccy: string, small: boolean): Intl.NumberFormat {
  const key = `${ccy}:${small ? "s" : "n"}`;
  let fmt = symbolFormatters.get(key);
  if (!fmt) {
    const display = SYMBOL_CURRENCIES[ccy]?.display ?? "symbol";
    const zeroDecimal =
      new Intl.NumberFormat("en-US", { style: "currency", currency: ccy }).resolvedOptions()
        .maximumFractionDigits === 0;
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: ccy,
      currencyDisplay: display,
      ...(zeroDecimal ? {} : { minimumFractionDigits: 2, maximumFractionDigits: small ? 4 : 2 }),
    });
    symbolFormatters.set(key, fmt);
  }
  return fmt;
}

/**
 * Price with the currency SYMBOL, as the Overview shows it: "$242.50", "€380.25", "£12.30", "¥3,120", "CA$12.00", "S$4.10".
 * Only USD is a bare "$"; currencies whose short symbol is shared (CAD, AUD, HKD, TWD, SGD, MXN, CNY, kr) get their prefixed form.
 * A currency outside the list (GBp, ILS, ZAc, ...) keeps the `formatMoney` text ("1,234.50 GBp"). `minor: true` converts a
 * minor-unit price first, as in `formatMoney` ("£12.34"). `null`, `undefined` and NaN are "n/a".
 */
export function formatPrice(
  value: number | null | undefined,
  ccy: string,
  opts: { minor?: boolean } = {},
): string {
  if (!isNum(value)) return NA;
  let v = value;
  let code = ccy;
  if (opts.minor) {
    const unit = resolveCurrency(ccy);
    if (unit.divisor !== 1) {
      v = value / unit.divisor;
      code = unit.major;
    }
  }
  const entry = SYMBOL_CURRENCIES[code];
  if (!entry) return formatMoney(value, ccy, opts);
  const small = v !== 0 && Math.abs(v) < 1;
  const fmt = symbolFormatter(code, small);
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  if (Math.abs(v) < 0.5 * 10 ** -digits) v = 0; // never "-$0.00"
  if (!entry.symbol) return fmt.format(v);
  const override = entry.symbol;
  return fmt
    .formatToParts(v)
    .filter((p) => p.type !== "literal")
    .map((p) => (p.type === "currency" ? override : p.value))
    .join("");
}

const CAP_UNITS = [
  { d: 1e12, s: "T" },
  { d: 1e9, s: "B" },
  { d: 1e6, s: "M" },
] as const;

function capText(value: number, unit: (typeof CAP_UNITS)[number]): number {
  const scaled = value / unit.d;
  const digits = unit.s === "T" ? 2 : Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return Number(scaled.toFixed(digits));
}

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  let index = CAP_UNITS.findIndex((u) => abs >= u.d);
  if (index === -1) {
    if (Math.round(abs) < 1e6) return integer.format(value);
    index = CAP_UNITS.length - 1; // 999,999.6 rounds to 1M
  }
  let unit = CAP_UNITS[index] as (typeof CAP_UNITS)[number];
  let text = capText(value, unit);
  while (Math.abs(text) >= 1000 && index > 0) {
    index -= 1;
    unit = CAP_UNITS[index] as (typeof CAP_UNITS)[number];
    text = capText(value, unit);
  }
  return `${text}${unit.s}`;
}

/** "1.23T USD", "456B USD", "850M EUR". Market caps are reported in the major unit; never divide. A value that rounds to 1000 of a unit moves up one unit (999.6M is 1B). */
export function formatMarketCap(
  value: number | null | undefined,
  ccy: string | null | undefined,
): string {
  if (!isNum(value)) return NA;
  return `${compactNumber(value)}${ccy ? ` ${ccy}` : ""}`;
}

const prefixCache = new Map<string, string>();
/** The text `formatPrice` puts before the number for a table currency: "$", "HK$", "S$", "CHF " (plain space). */
function symbolPrefix(code: string): string {
  let prefix = prefixCache.get(code);
  if (prefix === undefined) {
    const override = SYMBOL_CURRENCIES[code]?.symbol;
    const parts = symbolFormatter(code, false)
      .formatToParts(1)
      .filter((p) => !override || p.type !== "literal");
    const first = parts.findIndex((p) => p.type === "integer");
    prefix = parts
      .slice(0, first)
      .map((p) => (p.type === "currency" && override ? override : p.value))
      .join("")
      .replace(/\s+$/u, "\u00a0");
    prefixCache.set(code, prefix);
  }
  return prefix;
}

/**
 * Compact amount with the `formatPrice` currency symbol: "$5.34T", "HK$3.76T", "€231B", "CHF 88B", "$850M".
 * Same symbol table and ambiguity rules as `formatPrice`. A currency outside the table (GBp, ILS, ...) keeps the
 * `formatMarketCap` text ("88B ILS"); no currency gives the bare number. `null`, `undefined` and NaN are "n/a".
 */
export function formatCompactPrice(
  value: number | null | undefined,
  ccy: string | null | undefined,
): string {
  if (!isNum(value)) return NA;
  if (!ccy || !SYMBOL_CURRENCIES[ccy]) return formatMarketCap(value, ccy);
  const text = compactNumber(value);
  return text.startsWith("-")
    ? `-${symbolPrefix(ccy)}${text.slice(1)}`
    : `${symbolPrefix(ccy)}${text}`;
}

/** Explicit sign for non-zero values: "+1.23%", "-0.50%", "0.00%". */
export function formatPct(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return NA;
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return `${(0).toFixed(digits)}%`;
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(digits)}%`;
}

const SOFIA = "Europe/Sofia";
const sofiaFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: SOFIA,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: SOFIA,
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Date and time in Europe/Sofia: "15 Oct 2026, 10:41" (+ " (Europe/Sofia)" with `zoneLabel`). */
export function formatSofia(
  ts: string | number | Date | null | undefined,
  opts: { zoneLabel?: boolean } = {},
): string {
  if (ts === null || ts === undefined) return NA;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return NA;
  const s = sofiaFmt.format(d);
  return opts.zoneLabel ? `${s} (${SOFIA})` : s;
}

/** A trading-session date "YYYY-MM-DD" shown as a date; parsed at noon UTC so no zone can shift the day. */
export function formatSessionDate(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NA;
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return NA;
  return dayFmt.format(d);
}

/**
 * The exchange-local ticker of a listing (spec 5.5): "RMS.PA" shows "RMS". When the exchange code is unknown the listing
 * country tells a US listing (symbol kept) from another one (suffix stripped); with neither known the symbol is unchanged.
 */
export function homeTicker(
  yahooSymbol: string,
  exchangeCode: string | null | undefined,
  listingCountry?: string | null,
): string {
  if (exchangeCode) return displayTicker(yahooSymbol, exchangeCode);
  if (!listingCountry) return yahooSymbol;
  return displayTicker(yahooSymbol, listingCountry === "United States" ? "NYQ" : "");
}

/** "#53 MSFT" (ticker only when the rank is unknown). */
export function formatRankTicker(rank: number | null | undefined, ticker: string): string {
  return isNum(rank) ? `#${rank} ${ticker}` : ticker;
}

const shortFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: SOFIA,
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const clockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: SOFIA,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: SOFIA, weekday: "short" });
const monthDayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: SOFIA,
  month: "short",
  day: "numeric",
});

function toDate(ts: string | number | Date | null | undefined): Date | null {
  if (ts === null || ts === undefined) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Sofia date and time for the Overview: "Oct 16, 13:06". */
export function formatSofiaShort(ts: string | number | Date | null | undefined): string {
  const d = toDate(ts);
  return d ? shortFmt.format(d) : NA;
}

/** Sofia clock time: "14:10". */
export function formatSofiaClock(ts: string | number | Date | null | undefined): string {
  const d = toDate(ts);
  return d ? clockFmt.format(d) : NA;
}

/** Sofia weekday and clock time: "Mon 10:00". */
export function formatSofiaDayClock(ts: string | number | Date | null | undefined): string {
  const d = toDate(ts);
  return d ? `${weekdayFmt.format(d)} ${clockFmt.format(d)}` : NA;
}

/** A trading-session date "YYYY-MM-DD" as "Oct 15" (noon UTC, so no zone shifts the day). */
export function formatMonthDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NA;
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return NA;
  return monthDayFmt.format(d);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Statement descriptions can arrive with XML entities still in them ("VANG S&amp;P500 USDD"). Decodes the five named entities and
 * numeric references in one pass (so "&amp;lt;" becomes "&lt;"); anything else is left as it is.
 */
export function decodeXmlEntities(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (m, dec, hex, name) => {
      if (name) return NAMED_ENTITIES[name as string] ?? m;
      const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    },
  );
}
