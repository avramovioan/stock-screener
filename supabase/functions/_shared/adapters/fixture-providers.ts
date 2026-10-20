import type { RawBar } from "../core/bars.ts";
import { type EurFixtures, loadEurFixtures, withEurFixtures } from "./fixture-eur.ts";
import type {
  ChartRequest,
  ChartResult,
  CompanyProfile,
  FxProvider,
  FxQuote,
  MarketDataProvider,
  QuoteRecord,
  ScreenerPage,
} from "./providers.ts";
import { mapQuote } from "./yahoo.ts";

/**
 * Offline providers for `tools/run-local-scan.ts --mode fixture` and the integration test. They answer from fixtures/integration/world.json,
 * a compact world built from the recorded Yahoo samples by tools/gen-integration-fixtures.ts. Refused unless the function environment
 * sets ALLOW_FIXTURE_PROVIDERS=1 (local only), so mock data can never be mistaken for production data (7.12).
 */

export interface WorldDonor {
  meta: {
    exchangeTimezoneName: string;
    regularMarketTime: string | null;
    currentTradingPeriod: { start: string; end: string } | null;
    firstTradeDate: string | null;
    instrumentType: string | null;
  };
  t: number[]; // session-open instants, epoch ms
  o: Array<number | null>;
  h: Array<number | null>;
  l: Array<number | null>;
  c: Array<number | null>;
  v: Array<number | null>;
}
export interface WorldSecurity {
  quote: Record<string, unknown>; // a recorded quote()/screener record
  profile: { country: string | null; sector: string | null; industry: string | null };
  bars: {
    donor: string;
    scale: number;
    overrides?: Record<string, [number, number, number, number]>;
  };
}
export interface World {
  fxDate: string;
  fx: Record<string, number>; // USD per unit of the major currency
  donors: Record<string, WorldDonor>;
  securities: Record<string, WorldSecurity>;
  sets: Record<string, string[]>; // fixture sets ("day1", "day2") -> the symbols that exist in that world
  /** Offline EUR data (catalogue pages, ISIN answers, EUR quote lines); absent in a world generated before P6. */
  eur?: EurFixtures | undefined;
}

async function optionalEurFixtures(): Promise<EurFixtures | undefined> {
  try {
    return await loadEurFixtures();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  }
}

export async function loadWorld(): Promise<World> {
  const text = await Deno.readTextFile(
    new URL("./fixtures/integration/world.json", import.meta.url),
  );
  const world = JSON.parse(text) as World;
  world.eur = await optionalEurFixtures();
  return world;
}

const msOf = (v: string | null): number | null => (v === null ? null : Date.parse(v));

export function createFixtureProviders(
  world: World,
  setName: string,
): { market: MarketDataProvider; fx: FxProvider } {
  const symbols = world.sets[setName];
  if (symbols === undefined) throw new Error(`unknown fixture set ${setName}`);
  const inSet = new Set(symbols);
  const quoteOf = (symbol: string): QuoteRecord | null => {
    const sec = world.securities[symbol];
    return sec === undefined || !inSet.has(symbol) ? null : mapQuote(sec.quote);
  };

  const market: MarketDataProvider = {
    id: "fixture",
    search: () => Promise.resolve({ hits: [], news: [] }),
    quote(requested) {
      return Promise.resolve(
        [...new Set(requested)].map(quoteOf).filter((q): q is QuoteRecord => q !== null),
      );
    },
    chart(symbol, _req: ChartRequest): Promise<ChartResult> {
      const sec = world.securities[symbol];
      const quote = quoteOf(symbol);
      if (sec === undefined || quote === null)
        return Promise.reject(new Error(`No data found, symbol may be delisted: ${symbol}`));
      const donor = world.donors[sec.bars.donor];
      if (donor === undefined)
        return Promise.reject(new Error(`fixture donor ${sec.bars.donor} missing`));
      const from = Date.parse(_req.period1);
      const bars: RawBar[] = [];
      donor.t.forEach((time, i) => {
        if (time < from) return;
        const override = sec.bars.overrides?.[String(time)];
        const scale = (v: number | null) => (v === null ? null : v * sec.bars.scale);
        bars.push({
          time,
          open: override ? override[0] : scale(donor.o[i] ?? null),
          high: override ? override[1] : scale(donor.h[i] ?? null),
          low: override ? override[2] : scale(donor.l[i] ?? null),
          close: override ? override[3] : scale(donor.c[i] ?? null),
          volume: donor.v[i] ?? null,
        });
      });
      const period = donor.meta.currentTradingPeriod;
      return Promise.resolve({
        meta: {
          currency: quote.currency,
          exchange: quote.exchange,
          exchangeTimezoneName: quote.exchangeTimezoneName ?? donor.meta.exchangeTimezoneName,
          firstTradeDateMs: quote.firstTradeDateMs,
          regularMarketTime: msOf(donor.meta.regularMarketTime),
          currentTradingPeriod:
            period === null
              ? null
              : { start: Date.parse(period.start), end: Date.parse(period.end) },
          instrumentType: donor.meta.instrumentType,
          longName: quote.longName,
        },
        bars,
        splits: [],
      });
    },
    profile(symbol): Promise<CompanyProfile> {
      const sec = world.securities[symbol];
      if (sec === undefined || !inSet.has(symbol))
        return Promise.reject(new Error(`No fundamentals data for ${symbol}`));
      return Promise.resolve({ symbol, ...sec.profile, summary: null, employees: null });
    },
    news: () => Promise.resolve([]),
    screen(req): Promise<ScreenerPage> {
      const rows = symbols
        .map(quoteOf)
        .filter(
          (q): q is QuoteRecord =>
            q !== null && q.exchange === req.exchange && (q.marketCap ?? 0) > req.minMarketCapLocal,
        )
        .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) || (a.symbol < b.symbol ? -1 : 1));
      const page = rows.slice(req.offset, req.offset + req.size);
      return Promise.resolve({
        total: rows.length,
        offset: req.offset,
        count: page.length,
        rows: page,
      });
    },
  };

  const fx: FxProvider = {
    id: "fixture",
    usdPerUnit(ccys) {
      const rates: FxQuote[] = [];
      const missing: string[] = [];
      for (const ccy of [...new Set(ccys)].sort()) {
        const v = world.fx[ccy];
        if (v === undefined) missing.push(ccy);
        else
          rates.push({
            ccy,
            usdPerUnit: v,
            rateDate: world.fxDate,
            source: "frankfurter",
            sourceSymbol: null,
          });
      }
      return Promise.resolve({ rates, missing });
    },
  };
  return { market: world.eur === undefined ? market : withEurFixtures(market, world.eur), fx };
}
