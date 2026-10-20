// biome-ignore-all lint/suspicious/noExplicitAny: recorded provider samples and PostgREST/function responses are untyped JSON
// Builds supabase/functions/_shared/adapters/fixtures/integration/world.json for the fixture-mode scan (7.12, 17.4).
// Usage: bun run tools/gen-integration-fixtures.ts <spike raw dir>
//
// The world is built from recorded Yahoo samples: four real 11-year daily series (AAPL, NVDA, SAP.DE, 0700.HK) as "donors", twelve real quote
// records (plus derived cross-listings), real FX. Three securities get their last completed close engineered (fixed-point iteration against the
// core indicator) so the scan has a deterministic discount: 9988.HK closes below its -4 line, 1299.HK between its -4 and -3 lines, and JPM (the only US one, so the default `us` universe has a card) closes below its -4 line.
// Day 2 adds SHEL.L (currency GBp, cap in GBP) above 1299.HK in cap, which moves 1299.HK from rank 10 to 11 and so re-thresholds it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChartMeta, cleanBars, type RawBar } from "../supabase/functions/_shared/core/bars.ts";
import { computeChannel, DEFAULT_SETTINGS } from "../supabase/functions/_shared/core/indicator.ts";

const rawDir = process.argv[2];
if (rawDir === undefined) {
  console.error("usage: bun run tools/gen-integration-fixtures.ts <spike raw dir>");
  process.exit(1);
}
const NOW = Date.parse("2026-10-15T07:00:00Z"); // the scan start of fixture day 1 (10:00 Sofia in summer time)
const KEEP_BARS = 2900;
const read = (name: string): any => JSON.parse(readFileSync(join(rawDir, name), "utf8"));
const r4 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1e4) / 1e4);

// ---------------------------------------------------------------- donors
const donors: Record<string, any> = {};
for (const name of ["AAPL", "NVDA", "SAP.DE", "0700.HK"]) {
  const c = read(`chart_${name}.json`);
  const q = c.quotes.slice(-KEEP_BARS);
  donors[name] = {
    meta: {
      exchangeTimezoneName: c.meta.exchangeTimezoneName,
      regularMarketTime: c.meta.regularMarketTime,
      currentTradingPeriod: c.meta.currentTradingPeriod?.regular
        ? {
            start: c.meta.currentTradingPeriod.regular.start,
            end: c.meta.currentTradingPeriod.regular.end,
          }
        : null,
      firstTradeDate: c.meta.firstTradeDate ?? null,
      instrumentType: c.meta.instrumentType ?? null,
    },
    t: q.map((b: any) => Date.parse(b.date)),
    o: q.map((b: any) => r4(b.open)),
    h: q.map((b: any) => r4(b.high)),
    l: q.map((b: any) => r4(b.low)),
    c: q.map((b: any) => r4(b.close)),
    v: q.map((b: any) => b.volume),
  };
}

// ---------------------------------------------------------------- quotes
const KEEP = [
  "language",
  "region",
  "market",
  "symbol",
  "quoteType",
  "currency",
  "financialCurrency",
  "exchange",
  "fullExchangeName",
  "longName",
  "shortName",
  "marketCap",
  "sharesOutstanding",
  "regularMarketPrice",
  "regularMarketTime",
  "regularMarketPreviousClose",
  "regularMarketChangePercent",
  "marketState",
  "firstTradeDateMilliseconds",
  "exchangeTimezoneName",
  "priceHint",
  "averageDailyVolume3Month",
];
const quote50: any[] = read("quote_50.json");
const pick = (symbol: string): any => {
  const q = quote50.find((x) => x.symbol === symbol);
  if (q === undefined) throw new Error(`quote_50.json has no ${symbol}`);
  return Object.fromEntries(KEEP.filter((k) => k in q).map((k) => [k, q[k]]));
};
const fx = read("fx.json") as Record<string, number>;

const goog = {
  ...pick("GOOGL"),
  symbol: "GOOG",
  marketCap: 4203e9,
  averageDailyVolume3Month: 20_000_000,
};
const msft = pick("MSFT");
const msfde = {
  ...msft,
  symbol: "MSF.DE",
  currency: "EUR",
  financialCurrency: "USD",
  exchange: "GER",
  fullExchangeName: "XETRA",
  exchangeTimezoneName: "Europe/Berlin",
  marketCap: Math.round((msft.marketCap / fx["EUR"]!) * 0.995),
  regularMarketPrice: Math.round((msft.regularMarketPrice / fx["EUR"]!) * 100) / 100,
  averageDailyVolume3Month: 15_000,
};

// 9988.HK listed in 2019, which fails the 10-year listing-age rule (listing_too_new); the synthetic world gives it the donor's (0700.HK) listing date.
const aliba = {
  ...pick("9988.HK"),
  firstTradeDateMilliseconds: pick("0700.HK").firstTradeDateMilliseconds,
};

type Spec = {
  quote: any;
  country: string | null;
  sector: string | null;
  industry: string | null;
  donor: string;
  scale: number;
};
const specs: Record<string, Spec> = {
  AAPL: {
    quote: pick("AAPL"),
    country: "United States",
    sector: "Technology",
    industry: "Consumer Electronics",
    donor: "AAPL",
    scale: 1,
  },
  MSFT: {
    quote: msft,
    country: "United States",
    sector: "Technology",
    industry: "Software - Infrastructure",
    donor: "AAPL",
    scale: 1.55,
  },
  NVDA: {
    quote: pick("NVDA"),
    country: "United States",
    sector: "Technology",
    industry: "Semiconductors",
    donor: "NVDA",
    scale: 1,
  },
  GOOGL: {
    quote: pick("GOOGL"),
    country: "United States",
    sector: "Communication Services",
    industry: "Internet Content & Information",
    donor: "NVDA",
    scale: 1.7,
  },
  GOOG: {
    quote: goog,
    country: "United States",
    sector: "Communication Services",
    industry: "Internet Content & Information",
    donor: "NVDA",
    scale: 1.68,
  },
  JPM: {
    quote: pick("JPM"),
    country: "United States",
    sector: "Financial Services",
    industry: "Banks - Diversified",
    donor: "AAPL",
    scale: 0.9,
  },
  LLY: {
    quote: pick("LLY"),
    country: "United States",
    sector: "Healthcare",
    industry: "Drug Manufacturers - General",
    donor: "NVDA",
    scale: 5,
  },
  "SAP.DE": {
    quote: pick("SAP.DE"),
    country: "Germany",
    sector: "Technology",
    industry: "Software - Application",
    donor: "SAP.DE",
    scale: 1,
  },
  "MSF.DE": {
    quote: msfde,
    country: "United States",
    sector: "Technology",
    industry: "Software - Infrastructure",
    donor: "AAPL",
    scale: 1.55 * 0.89,
  },
  "0700.HK": {
    quote: pick("0700.HK"),
    country: "China",
    sector: "Communication Services",
    industry: "Internet Content & Information",
    donor: "0700.HK",
    scale: 1,
  },
  "9988.HK": {
    quote: aliba,
    country: "China",
    sector: "Consumer Cyclical",
    industry: "Internet Retail",
    donor: "0700.HK",
    scale: 0.27,
  },
  "1299.HK": {
    quote: pick("1299.HK"),
    country: "Hong Kong",
    sector: "Financial Services",
    industry: "Insurance - Life",
    donor: "0700.HK",
    scale: 0.12,
  },
  "SHEL.L": {
    quote: pick("SHEL.L"),
    country: "United Kingdom",
    sector: "Energy",
    industry: "Oil & Gas Integrated",
    donor: "SAP.DE",
    scale: 22,
  },
};
const day1 = Object.keys(specs).filter((s) => s !== "SHEL.L");
const day2 = Object.keys(specs);

// ---------------------------------------------------------------- engineering the two discount candidates
function cleaned(symbol: string, overrides: Record<string, [number, number, number, number]>) {
  const s = specs[symbol]!;
  const d = donors[s.donor];
  const period = d.meta.currentTradingPeriod;
  const meta: ChartMeta = {
    exchangeTimezoneName: s.quote.exchangeTimezoneName ?? d.meta.exchangeTimezoneName,
    regularMarketTime:
      d.meta.regularMarketTime === null ? null : Date.parse(d.meta.regularMarketTime),
    currentTradingPeriod:
      period === null ? null : { start: Date.parse(period.start), end: Date.parse(period.end) },
    marketState: s.quote.marketState,
  };
  const raw: RawBar[] = d.t.map((time: number, i: number) => {
    const ov = overrides[String(time)];
    const sc = (v: number | null) => (v === null ? null : v * s.scale);
    return ov
      ? { time, open: ov[0], high: ov[1], low: ov[2], close: ov[3], volume: d.v[i] }
      : {
          time,
          open: sc(d.o[i]),
          high: sc(d.h[i]),
          low: sc(d.l[i]),
          close: sc(d.c[i]),
          volume: d.v[i],
        };
  });
  return { raw, ...cleanBars(raw, meta, NOW) };
}

const overridesBySymbol: Record<string, Record<string, [number, number, number, number]>> = {};
function engineer(symbol: string, target: (lower1: number, lower2: number) => number): void {
  const ov: Record<string, [number, number, number, number]> = {};
  const first = cleaned(symbol, ov);
  // the last COMPLETED bar is the one the handler will retain: find its raw timestamp
  const lastDay = first.series.dates[first.series.dates.length - 1]!;
  const lastRaw = [...first.raw].reverse().find(
    (b: RawBar) =>
      b.close !== null &&
      b.high !== null &&
      cleanBars(
        [b],
        {
          exchangeTimezoneName:
            specs[symbol]!.quote.exchangeTimezoneName ??
            donors[specs[symbol]!.donor].meta.exchangeTimezoneName,
          regularMarketTime: null,
          currentTradingPeriod: { start: b.time + 1, end: b.time + 2 },
        },
        NOW,
      ).series.dates[0] === lastDay,
  )!;
  let close = first.series.close[first.series.close.length - 1]!;
  for (let i = 0; i < 60; i++) {
    ov[String(lastRaw.time)] = [close * 0.995, close * 1.012, close * 0.985, close];
    const out = computeChannel(cleaned(symbol, ov).series, DEFAULT_SETTINGS);
    if (!out.ok) throw new Error(`${symbol}: ${out.reason}`);
    const next = target(out.channel.end.lower1, out.channel.end.lower2);
    if (Math.abs(next - close) < 1e-9 * Math.abs(close)) break;
    close = next;
  }
  overridesBySymbol[symbol] = ov;
}
engineer("9988.HK", (_l1, l2) => l2 * 0.99); // deep discount: below the -4 line (reached_line4)
engineer("1299.HK", (l1, l2) => l2 + (l1 - l2) * 0.5); // between the lines: a -3 discount at any rank (rank 11 on day 2 only changes its tag to "wait for the -4 line")
engineer("JPM", (_l1, l2) => l2 * 0.99); // the one US discount (below the -4 line): the `us` universe, the default since 2026-10-16, needs a card

// ---------------------------------------------------------------- report
const rows: string[] = [];
for (const [symbol, s] of Object.entries(specs)) {
  const c = cleaned(symbol, overridesBySymbol[symbol] ?? {});
  const out = computeChannel(c.series, DEFAULT_SETTINGS);
  if (!out.ok) throw new Error(`${symbol}: ${out.reason} (${c.series.dates.length} bars)`);
  const ch = out.channel;
  const close = c.series.close[c.series.close.length - 1]!;
  rows.push(
    `${symbol.padEnd(8)} bars ${String(c.series.dates.length).padStart(4)} rising ${String(ch.rising).padEnd(5)} close ${close.toFixed(3).padStart(10)} lower1 ${ch.end.lower1.toFixed(3).padStart(10)} lower2 ${ch.end.lower2.toFixed(3).padStart(10)} suspect ${c.report.suspect}`,
  );
  if (!ch.rising) throw new Error(`${symbol} is not rising: choose another donor or scale`);
  if (c.report.suspect) throw new Error(`${symbol} is suspect`);
  if (!(ch.end.lower2 > 0)) throw new Error(`${symbol} lower line not positive`);
  void s;
}
console.log(rows.join("\n"));

// ---------------------------------------------------------------- write
const world = {
  fxDate: "2026-10-14",
  fx,
  donors,
  securities: Object.fromEntries(
    Object.entries(specs).map(([symbol, s]) => [
      symbol,
      {
        quote: s.quote,
        profile: { country: s.country, sector: s.sector, industry: s.industry },
        bars: {
          donor: s.donor,
          scale: s.scale,
          ...(overridesBySymbol[symbol] ? { overrides: overridesBySymbol[symbol] } : {}),
        },
      },
    ]),
  ),
  sets: { day1, day2 },
};
const outDir = join(
  import.meta.dirname ?? ".",
  "..",
  "supabase",
  "functions",
  "_shared",
  "adapters",
  "fixtures",
  "integration",
);
mkdirSync(outDir, { recursive: true });
const text = JSON.stringify(world);
writeFileSync(join(outDir, "world.json"), text);
console.log(`wrote world.json (${(text.length / 1024).toFixed(0)} KB)`);
