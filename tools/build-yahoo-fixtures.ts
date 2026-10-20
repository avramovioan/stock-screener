// Builds the small recorded Yahoo fixtures from the spike's raw JSON samples.
// Usage: bun run tools/build-yahoo-fixtures.ts <spike raw dir>
// The spike samples are library outputs (post-parse) or raw screener result objects; they are trimmed, never edited.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// biome-ignore lint/suspicious/noExplicitAny: spike samples are untyped JSON that is only trimmed
type Raw = any;

const rawDir = process.argv[2];
if (rawDir === undefined) {
  console.error("usage: bun run tools/build-yahoo-fixtures.ts <spike raw dir>");
  process.exit(1);
}
const outDir = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "supabase",
  "functions",
  "_shared",
  "adapters",
  "fixtures",
  "yahoo",
);
mkdirSync(outDir, { recursive: true });

const read = (name: string): Raw => JSON.parse(readFileSync(join(rawDir, name), "utf8"));
const write = (name: string, value: unknown): void => {
  writeFileSync(join(outDir, name), JSON.stringify(value, null, 1) + "\n");
  console.log("wrote", name);
};

const QUOTE_KEEP = [
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
const pick = (q: Raw): Raw =>
  Object.fromEntries(QUOTE_KEEP.filter((k) => k in q).map((k) => [k, q[k]]));

// chart(): meta + the bars the tests need + events
const tail = (n: number) => (c: Raw) => ({
  meta: c.meta,
  quotes: c.quotes.slice(-n),
  events: { splits: c.events?.splits ?? [] },
});
write("chart_SAP.DE.trim.json", {
  ...tail(40)(read("chart_SAP.DE.json")),
  note: "last bar is FORMING and 2026-10-14 is a null bar (spike 3.2)",
});
write("chart_AAPL.trim.json", tail(40)(read("chart_AAPL.json")));
write("chart_7203.T.trim.json", tail(40)(read("chart_7203.T.json")));
write("chart_0700.HK.trim.json", tail(40)(read("chart_0700.HK.json")));
const nvda = read("chart_NVDA.json");
write("chart_NVDA.trim.json", {
  meta: nvda.meta,
  quotes: nvda.quotes.filter((q: Raw) => q.date >= "2024-06-03" && q.date < "2024-06-13"),
  events: { splits: nvda.events.splits },
});

// quote(): twelve real records, including SHEL.L (currency GBp, marketCap in GBP)
const wanted = [
  "AAPL",
  "MSFT",
  "NVDA",
  "GOOGL",
  "SAP.DE",
  "SHEL.L",
  "7203.T",
  "0700.HK",
  "2222.SR",
  "2330.TW",
  "ASML.AS",
  "BRK-B",
];
const q50: Raw[] = read("quote_50.json");
write(
  "quote_12.trim.json",
  wanted.map((s) => pick(q50.find((q) => q.symbol === s))),
);

// quoteSummary() and search()
const qs = read("quoteSummary_SAP.DE.json");
write("quoteSummary_SAP.DE.trim.json", {
  assetProfile: {
    ...qs.assetProfile,
    longBusinessSummary: String(qs.assetProfile.longBusinessSummary).slice(0, 200),
  },
  quoteType: qs.quoteType,
});
const search = read("search_US5949181045.json");
write("search_US5949181045.trim.json", {
  quotes: search.quotes.slice(0, 1),
  news: search.news.slice(0, 2).map(({ thumbnail, ...rest }: Raw) => rest),
});

// raw screener result objects (result[0] of the HTTP response)
for (const [file, out] of [
  ["screener_gb_p1.json", "screener_gb.trim.json"],
  ["screener_us_p1.json", "screener_us.trim.json"],
] as const) {
  const s = read(file);
  write(out, {
    start: 0,
    count: 5,
    total: s.total,
    quotes: s.quotes.slice(0, 5).map(pick),
    useRecords: false,
  });
}
