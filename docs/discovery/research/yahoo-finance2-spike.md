# yahoo-finance2 technical spike (2026-10-15)

Throwaway hands-on spike of the npm package `yahoo-finance2` for the daily screening backend. Every claim below comes from a command run on 2026-10-15 (07:30-08:15 UTC, i.e. Europe/Asia open, US closed). Raw JSON samples and scripts live in the spike directory (section 9), not in the repo.

Spike dir: `C:\Users\IOANAV~1\AppData\Local\Temp\claude\C--Data-git-repos--tests-nira-personal-stock-sreener\aa696ef1-a34b-4ef2-99b8-f428d2600088\scratchpad\yf2-spike\` (abbreviated `$SPIKE`).

## 1. Executive verdict

| Question | Verdict |
|---|---|
| Installed | `yahoo-finance2` **4.0.3** (MIT). Unofficial, not endorsed by Yahoo, "use at your own risk". |
| Runs in Supabase Edge Runtime? | **Yes.** `npm:yahoo-finance2` ran unchanged in `supabase/edge-runtime:v1.77.4` (Deno 2.1.4 compat): quote, chart (3249 bars), search all OK. Library prints a harmless warning `Unsupported environment: Requires Deno >= 2.0.0, found supabase-edge-runtime-1.77.4 ...` (its version parse fails on the runtime string). Also OK on plain Deno 2.9.6, Node 22, Bun 1.3.14. |
| Universe discovery | **Library: No** (only 15 predefined, US-only screeners, no custom query). **Raw Yahoo custom screener endpoint (`POST /v1/finance/screener`): Yes, works** with cookie+crumb, filters by `intradaymarketcap`, `region`, `exchange`, `sector`; pages with `size<=250` + `offset`. **Critical caveat: the market-cap threshold is applied in the listing's LOCAL currency, not USD**, and results are sorted by the raw local number. So "US$50B" must be implemented as per-exchange thresholds = 50e9 / FX. Worldwide the screener also returns many secondary/duplicate listings (Vienna, Frankfurt, Sao Paulo BDRs, Mexico, Buenos Aires CEDEARs, Cboe CA CDRs, OTC), which must be de-duplicated. |
| Adjustment policy | **`chart().quotes[].close` is split-adjusted and NOT dividend-adjusted; `adjclose` is split+dividend-adjusted.** Proven in section 3.2 (NVDA 10:1, AAPL 4:1 continuity, plus close != adjclose on old dates). Exactly the TradingView-style series we need: use `close` (and open/high/low, which are also split-adjusted, not dividend-adjusted). |
| ISIN -> EUR listing | **Partly workable, not direct.** `search(ISIN)` returns only ONE quote: the primary listing (MSFT for US5949181045, SAP.DE for DE0007164600). EUR lines (MSF.DE, MSF.F) appear only through a NAME search (`search('Microsoft Corporation')`) and are incomplete (no MSF.MU/MSF.SG/MSFT.VI in results). Equivalence can be verified with `quote()`: identical `sharesOutstanding` (7425545491 for MSFT, MSF.DE, MSF.F, MSFT.VI), matching `longName`, and price x EURUSD within ~1% (530.2 vs 533.7). Beware look-alikes: `MSFT.AS` is a leveraged tracker ETP, `ASM.F` is a different company. |
| News | **Partial.** `search(symbol, {newsCount})` returns `news[]` (uuid, title, publisher, link, providerPublishTime, type, relatedTickers) but only for US-style tickers (MSFT, AAPL, SAP ADR). Exchange-suffixed symbols (SAP.DE, 7203.T, 0700.HK, NESN.SW, ASML.AS, MC.PA, RELIANCE.NS) return 0 news. Max 50 items per call. No dedicated news module. |
| Rate limits | 60 sequential single-symbol `quote()` at ~3.7/s and 20 `chart()` at 2/s: **0 errors, no 429**. Bulk `quote()` accepted 2500 symbols in one call; 4000 failed with HTTP 414 (URI too long). |
| Biggest risks | Unofficial endpoints (can break any day), crumb/cookie handling per cold start, no ISIN field anywhere, no ADR flag, null OHLCV rows inside chart data, minor currency units (GBp, ZAc, ILA), duplicate listings in screener output. |

## 2. Capability matrix (requirements 1-7)

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Universe discovery (>=US$50B worldwide + US subset) | **Partial** (library No; raw endpoint Yes) | 3.7 (a)-(c); 486-526 distinct companies >=US$50B after FX filter + dedup |
| 2 | Market cap native currency + timestamp + shares outstanding | **Yes** | 3.3: `marketCap`, `sharesOutstanding`, `regularMarketTime`, `currency` present 50/50 in bulk quote. Timestamp = `regularMarketTime` of the quote (market cap is computed on the latest price; no separate market-cap timestamp) |
| 3 | Identity: exchange, currency, quoteType, first trade date | **Yes** | 3.3/3.4 (`exchange`, `fullExchangeName`, `currency`, `quoteType`, `firstTradeDateMilliseconds`, chart `meta.firstTradeDate`). ISIN: **No**. ADR flag: **No** (infer from home country in `assetProfile.country` vs exchange). EUR-listing lookup: **Partial** (3.5) |
| 4 | 11+ years daily OHLCV, split-adjusted not dividend-adjusted, events | **Yes** | 3.2: 3143-3274 bars from 2014-01-02 for 7 of 8 symbols (2222.SR only from IPO 2019-12-11); `events.dividends`, `events.splits` returned |
| 5 | Latest completed daily bar / forming detection | **Yes (derived rule)** | 3.2: rule using `meta.regularMarketTime`, `meta.currentTradingPeriod.regular` and bar date; cross-checked with quote `marketState` |
| 6 | Company news headlines + URLs + dates | **Partial** | 3.6: only for US-style tickers via `search()` |
| 7 | Runs in Supabase Edge Functions (Deno) | **Yes** | 3.9: works in edge-runtime 1.77.4; 12 charts + 500-symbol quote in 7.5 s wall; CPU limit not measurable locally |

## 3. Per-task findings

### 3.1 Install, licence, disclaimer, modules

```
$ bun init -y ; bun add yahoo-finance2     -> 108 packages installed
node_modules/yahoo-finance2/package.json: "version": "4.0.3", "license": "MIT", "engines": {"node": ">=22.0.0"}
```
- **v4 (2026) vs v3**: UPGRADING.md: "From v3 to v4: requires Node.js 22+. There are no other breaking API changes."
- **v3 vs v2** (applies to our 4.0.3): default export is a class; `new YahooFinance(opts)` required (static call throws `Call const yahooFinance = new YahooFinance() first. Upgrading from v2?`); `setGlobalConfig` removed; `suppressNotices` is a constructor option (`['yahooSurvey']`, `['ripHistorical']`); `dailyGainers`/`dailyLosers` removed (use `screener`); browser use unsupported.
- **`historical()` still exists but is deprecated**: it is mapped onto `chart()` and prints `[Deprecated] historical() relies on an API that Yahoo have removed. We'll map this request to chart() ...` (notice id `ripHistorical`). Use `chart()`; note `historical` returns `adjClose` while `chart` returns `adjclose`.
- Exported modules (`esm/src/modules`): autoc, chart, dailyGainers (deprecated stub), dailyLosers (deprecated stub), fundamentalsTimeSeries, historical, insights, options, quote, quoteSummary, recommendationsBySymbol, screener, search, trendingSymbols; other: `quoteCombine`. quoteSummary submodules per README: assetProfile, balanceSheetHistory(+Quarterly), calendarEvents, cashflowStatementHistory(+Quarterly), defaultKeyStatistics, earnings, earningsHistory, earningsTrend, financialData, fundOwnership, fundPerformance, fundProfile, incomeStatementHistory(+Quarterly), indexTrend, industryTrend, insiderHolders, insiderTransactions, institutionOwnership, majorDirectHolders, majorHoldersBreakdown, netSharePurchaseActivity, price, quoteType, recommendationTrend, secFilings, sectorTrend, summaryDetail, summaryProfile, symbol, topHoldings, upgradeDowngradeHistory.
- Also ships a CLI (`yahoo-finance2`), an MCP server (`yahoo-finance2/mcp`) and an Agent Skill.
- README "Supported runtimes": Bun v1+, Cloudflare (nodejs_compat), Deno v2+, Node v22+.
- Library internals relevant to us: crumb obtained by GET `https://finance.yahoo.com/quote/AAPL` (cookie + consent redirect handling, `getCrumb.js`), cached in an in-memory `tough-cookie` jar; default host `query2.finance.yahoo.com`; request queue default `concurrency: 4`, **no built-in rate limiting and no retry on 429/5xx** (throws `HTTPError` with `.code`); `quoteCombine` default `maxSymbolsPerRequest: 100`, `debounceTime: 50`; custom `cookieJar`, `fetch`, `fetchOptions`, `logger` options exist.

### 3.2 Historical bars via chart() (task 2)

Command: `yf.chart(sym,{period1:"2014-01-01",interval:"1d",events:"div|split"})` (script `$SPIKE\t2.ts`, raw `$SPIKE\raw\chart_<SYM>.json`).

| Symbol | bars | first bar | last bar | currency | exchangeName / fullExchangeName | timezone | gmtoffset | priceHint | firstTradeDate | splits | #div | null-OHLC bars | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AAPL | 3215 | 2014-01-02 | 2026-10-14 | USD | NMS / NasdaqGS | America/New_York | -14400 | 2 | 1980-12-12 | 7:1 (2014-06-09), 4:1 (2020-08-31) | 51 | 0 | 605 |
| NVDA | 3215 | 2014-01-02 | 2026-10-14 | USD | NMS / NasdaqGS | America/New_York | -14400 | 2 | 1999-01-22 | 4:1 (2021-07-20), 10:1 (2024-06-10) | 51 | 0 | 263 |
| SAP.DE | 3249 | 2014-01-02 | 2026-10-15 | EUR | GER / XETRA | Europe/Berlin | 7200 | 2 | 1998-04-09 | none | 13 | 1 (2026-10-14!) | 299 |
| 7203.T | 3143 | 2014-01-06 | 2026-10-15 | JPY | JPX / Tokyo | Asia/Tokyo | 32400 | 2 | 1999-05-06 | 5:1 (2021-09-29) | 26 | 0 | 308 |
| 0700.HK | 3150 | 2014-01-02 | 2026-10-15 | HKD | HKG / HKSE | Asia/Hong_Kong | 28800 | 3 | 2004-06-16 | 5:1 (2014-05-15) | 13 | 0 | 214 |
| RELIANCE.NS | 3157 | 2014-01-01 | 2026-10-15 | INR | NSI / NSE | Asia/Kolkata | 19800 | 2 | 1996-01-01 | 2:1 (2017-09-07), 2:1 (2024-10-28) | 13 | 2 (2014-03-22, 2015-02-28) | 274 |
| 2222.SR | 1708 | 2019-12-11 | 2026-10-15 | SAR | SAU / Saudi | Asia/Riyadh | 10800 | 2 | 2019-12-11 | 11:10 (2022-05-15), 11:10 (2023-05-09) | 26 | 1 (2026-10-14) | 234 |
| NESN.SW | 3212 | 2014-01-03 | 2026-10-15 | CHF | EBS / Swiss | Europe/Zurich | 7200 | 2 | 1990-01-03 | none | 13 | 0 | 276 |

- `close != adjclose` for 3044-3190 bars per symbol (every bar before the latest dividend) - `adjclose` carries dividend adjustment.
- `meta` keys: `currency,symbol,exchangeName,fullExchangeName,instrumentType,firstTradeDate,regularMarketTime,hasPrePostMarketData,gmtoffset,timezone,exchangeTimezoneName,regularMarketPrice,regularMarketChangePercent,fulldayPrice,fulldayChange,fulldayChangePercent,fiftyTwoWeekHigh,fiftyTwoWeekLow,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,longName,shortName,chartPreviousClose,priceHint,currentTradingPeriod,dataGranularity,range,validRanges`.
- `currentTradingPeriod.regular` example (SAP.DE): `{"timezone":"CEST","start":"2026-10-15T07:00:00.000Z","end":"2026-10-15T15:30:00.000Z","gmtoffset":7200}`.
- **Bar timestamps are the session OPEN instant in UTC, not midnight** (AAPL `2026-10-14T13:30:00Z`, SAP.DE `07:00Z`, 7203.T `00:00Z`, 0700.HK `01:30Z`, RELIANCE `03:45Z`). Derive the trading date by converting to `exchangeTimezoneName` (or adding `gmtoffset`). Bars before a DST change use a different UTC hour (SAP.DE first bar `2014-01-02T08:00:00Z`).
- **Null bars exist**: SAP.DE and 2222.SR each returned a bar dated 2026-10-14 with `open/high/low/close/adjclose/volume = null` (`{"date":"2026-10-14T07:00:00.000Z","high":null,"volume":null,...}`), RELIANCE two. The library does not drop them: filter `close == null` and treat as missing data (do not treat as a trading day without cross-check).

**Adjustment proof** (`$SPIKE\t2b.ts`, from raw JSON):
```
NVDA 2024-06-07 close 120.888  adjclose 120.544   (10:1 split took effect 2024-06-10)
NVDA 2024-06-10 close 121.790  adjclose 121.444
AAPL 2020-08-28 close 124.8075 adjclose 120.9557  (4:1 split took effect 2020-08-31)
AAPL 2020-08-31 close 129.0400 adjclose 125.0575
AAPL 2014-01-02 close 19.7546  adjclose 17.1101   (7:1 split of 2014-06-09 also invisible: 06-06 close 23.056, 06-09 close 23.425)
NVDA 2014-01-02 close 0.3965   adjclose 0.3730
```
`close` is continuous across both splits (same magnitude, small day moves), so **`close` is split-adjusted**. On 2014-01-02 `close` (19.75) differs from `adjclose` (17.11) by ~13% = cumulative dividends only (the split ratio is already inside `close`), so **dividend adjustment lives only in `adjclose`**. Events: `events.splits[] = {date,numerator,denominator,splitRatio}`, `events.dividends[] = {amount,date}` (NVDA first/last: `0.002125` on 2014-02-25 / `0.25` on 2026-09-10; amounts are split-adjusted too).

**Forming vs completed last bar** (run at 07:42 UTC):
| Symbol | last bar date | `meta.regularMarketTime` | `currentTradingPeriod.regular` | State |
|---|---|---|---|---|
| SAP.DE | 2026-10-15T07:00Z | 07:27:36Z | 2026-10-15 07:00Z - 15:30Z | **forming** (bar.date == period.start and rmt < end) |
| 2222.SR | 2026-10-15T07:00Z | 07:27:40Z | 07:00Z - 12:00Z | forming |
| RELIANCE.NS | 2026-10-15T03:45Z | 07:42:40Z | 03:45Z - 10:00Z | forming |
| 7203.T | 2026-10-15T00:00Z | 06:30:00Z | 00:00Z - 06:30Z | **completed** (rmt >= end); quote `marketState: POSTPOST` |
| AAPL / NVDA | 2026-10-14T13:30Z | 2026-10-14T20:00:01Z | 2026-10-15 13:30Z - 20:00Z (NEXT session) | **completed** (bar.date < period.start); quote `marketState: PREPRE` |

Rule (derived from these observations; `meta.currentTradingPeriod` always describes the current-or-next session): a bar is **completed** if `bar.date < currentTradingPeriod.regular.start` OR `meta.regularMarketTime >= currentTradingPeriod.regular.end`; otherwise it is **forming** (do not persist it as final). Cross-check with `quote().marketState` (`REGULAR` = forming; `PRE`, `PREPRE`, `POST`, `POSTPOST`, `CLOSED` = not trading). Observed `marketState` values: REGULAR, PREPRE, POST, POSTPOST. Not verified by test: lunch breaks (HKG/JPX/SHH) and half-days, which need an extra manual check around the session end; also whether a completed bar's volume is final immediately after the close (re-fetch the last 5 bars next run).

### 3.3 Bulk quote (task 3)

`yf.quote([51 symbols])`: returned 50 in 996 ms (`ROG.SW` silently missing: unknown/unavailable symbols are omitted, no error). Raw: `raw\quote_50.json`.

Fields present: `marketCap` 50/50, `currency` 50/50, `financialCurrency` 50/50, `exchange` 50/50, `fullExchangeName` 50/50, `market` 50/50 (e.g. `us_market`, `de_market`), `quoteType` 50/50, `firstTradeDateMilliseconds` 50/50 (parsed to a Date by the library, e.g. `1986-03-13T14:30:00.000Z`), `sharesOutstanding` 50/50, `regularMarketPrice`, `regularMarketTime`, `regularMarketChangePercent`, `marketState`, `longName`, `exchangeTimezoneName` 50/50, `priceHint` 50/50, `displayName` only 20/50 (US names), `isin` 0/50 (does not exist). Also `shortName`, `impliedSharesOutstanding`, `gmtOffSetMilliseconds`, `exchangeTimezoneShortName`, price/volume/52-week/PE/dividend/earnings-date fields, `corporateActions`, `averageAnalystRating`.

Observed currency semantics (from `raw\quote_50.json`):
- `marketCap` is in the listing `currency` (JPY 35.7T for 7203.T, SAR 6.1T for 2222.SR, KRW 1.37e15 for 005930.KS), except **minor-unit currencies**: SHEL.L `currency: "GBp"` but `marketCap` 222.0e9 is in **GBP** (5.69e9 shares x ~39 GBP); likewise expect ZAc (JNB) and ILA (TLV) - convert minor unit /100 (KWF /1000) before FX. Verified only for GBp.
- `financialCurrency` can differ from trading currency (0700.HK: `HKD` vs `CNY`; SHOP.TO `CAD` vs `USD`; SHEL.L `GBp` vs `USD`).

Bulk limits (unique real symbols from the universe scan, `t3b.ts`/`t3c.ts`; the first 250-symbol attempt in `t3.ts` used duplicated/fake symbols and only proved the call does not fail):
| symbols per call | result |
|---|---|
| 250 | 250 returned, 1.3 s, 666 KB JSON (201 KB with `fields=` of 12 names) |
| 500 | 500 returned, 0.65 s, 1.3 MB |
| 1000 | 1000 returned, 0.9 s, 2.5 MB |
| 1500 | 1500 returned, 1.7 s, 3.6 MB |
| 2500 | 2500 returned, 3.7 s |
| 4000 | **HTTP 414 URI Too Long** (`Bad Message 414`, request is a GET with `symbols=` query string; ~16k chars OK, ~25k chars fails) |

No documented symbol cap was hit; the practical limit is URL length (~2500-3500 symbols). Use `fields` to cut payload (the `fields` option works).

### 3.4 quoteSummary (task 4)

`yf.quoteSummary(s,{modules:[price,summaryDetail,defaultKeyStatistics,assetProfile,summaryProfile,quoteType,calendarEvents]})`, MSFT 821 ms / 11 KB, SAP.DE 95 ms / 11 KB (`raw\quoteSummary_*.json`).

| Need | Field (MSFT / SAP.DE) |
|---|---|
| market cap | `price.marketCap` 3,962,939,637,760 USD / 231,417,954,304 EUR; also `summaryDetail.marketCap` (same), `summaryDetail.nonDilutedMarketCap` |
| shares outstanding | `defaultKeyStatistics.sharesOutstanding` 7,425,545,491 / 1,154,204,232 (also `impliedSharesOutstanding`, `floatShares` 7,414,407,173 / 1,029,546,400) |
| ISIN | **none** (regex search for an ISIN pattern across the whole result: null) |
| sector / industry | `assetProfile.sector` Technology / Technology; `assetProfile.industry` Software - Infrastructure / Software - Application (+ `sectorKey`, `industryKey`) |
| country | `assetProfile.country` United States / Germany (+ city, website, `fullTimeEmployees`) |
| business summary | `assetProfile.longBusinessSummary` (also in `summaryProfile`) |
| exchange timezone | `quoteType.timeZoneFullName` America/New_York / Europe/Berlin, `timeZoneShortName`, `gmtOffSetMilliseconds` |
| quoteType | `quoteType.quoteType` = `EQUITY`; `price.quoteType` same; `price.exchange` NMS / GER; `price.exchangeName` NasdaqGS / XETRA; `quoteType.firstTradeDateEpochUtc` |
| next earnings | `calendarEvents.earnings.earningsDate[]` 2026-10-28 / 2026-10-21 |

`quoteSummary` is the only source of country/summary (quote() has none of sector/industry/country); `search()` also returns `sector`/`industry` (3.5).

### 3.5 Search and ISIN lookup (task 5)

```
search('US5949181045') -> 1 quote: MSFT [NMS, NASDAQ, EQUITY, "Microsoft Corporation", sector Technology, industry Software—Infrastructure]  (+10 news)
search('DE0007164600') -> 1 quote: SAP.DE [GER, XETRA, EQUITY, "SAP SE", Technology]  (0 news)
search('US0378331005') -> AAPL only;  search('JP3633400001') -> 7203.T only;  search('NL0010273215') -> ASML.AS only;  search('CH0038863350') -> NESN.SW only
search('Microsoft') -> MSFT, SMSFT=F (FUTURE), XMSFT=F, MSFT.TO (CDR CAD hedged), MSF.DE [GER] "MICROSOFT CORP.", + 2 empty {isYahooFinance:false}
search('Microsoft Corporation') -> MSFT, MSFT.TO, MSF.DE, MSFT.NE, MSFT.MX, MSFTCO.CL, MSF.F
search('Apple Inc')       -> AAPL, AAPL.TO, AAPL19.BK, APC.DE, APC.F
search('NVIDIA Corporation') -> NVDA, NVDA.TO, NVD.DE, NVDA.NE, NVD.F, NVDA.MX, NVDACO.CL
search('ASML Holding')    -> ASML, ASML.AS, ASME.DE, ASML.TO(ETF), ASMLF(PNK), ASME.DU
```
`quotes[]` fields: `exchange, shortname, quoteType, symbol, index, score, typeDisp, longname, exchDisp, sector, sectorDisp, industry, industryDisp, isYahooFinance` (`dispSecIndFlag` sometimes). Result envelope also has `news`, `lists`, `nav`, `researchReports`, `count`, timing fields.

`quote(['MSF.DE','MSFT.MX','MSF.F', ...])` (`t5.ts`):
| symbol | currency | exchange | fullExchangeName | longName | price | marketCap | sharesOutstanding |
|---|---|---|---|---|---|---|---|
| MSF.DE | EUR | GER | XETRA | Microsoft Corporation | 472.85 | 3.511e12 | 7,425,545,491 |
| MSF.F | EUR | FRA | Frankfurt | Microsoft Corporation | 472.2 | 3.506e12 | 7,425,545,491 |
| MSFT.VI | EUR | VIE | Vienna | Microsoft Corporation | 472 | 3.505e12 | 7,425,545,491 |
| MSF.SG / MSF.MU | EUR | STU / MUN | Stuttgart / Munich | Microsoft Corp | 472.85 / 478.55 | - | - |
| MSFT.MX | **MXN** | MEX | Mexico | Microsoft Corporation | 9863.83 | 7.32e13 | 7,425,545,491 |
| MSFT.AS | EUR | AMS | Amsterdam | **LS 1x Microsoft Tracker ETP Securities** | 9.664 | - | - |

`EURUSD=X` = 1.1213 -> MSF.DE x FX = 530.22 USD vs MSFT 533.69 (0.65% apart: time-of-day gap, US closed). Other checks: APC.DE/APC.F (Apple Inc., shares 14,594,180,000 = AAPL), NVD.DE/NVD.F (24,147,000,000 = NVDA), ASME.DE and ASML.AS (384,100,000 = ASML), `ASM.F` shows a different company (shares 17,500,431,702, price 30.2) despite the "ASM" prefix.

**Conclusion**: ISIN -> primary listing is deterministic via `search(ISIN)`. ISIN -> EUR listing is NOT supported (no ISIN field on non-primary lines, no ISIN in quote/quoteSummary). Workable procedure: (1) `search(ISIN)` -> primary symbol and `longname`; (2) `search(longname)` and filter `quoteType==='EQUITY'` and `exchange in {GER,FRA,AMS,PAR,MIL}`; (3) `quote(candidates)` and accept only if `sharesOutstanding` is identical to the primary's AND `longName` matches AND `price x FX(EUR/primary ccy)` within ~2-3% of the primary price; (4) persist the verified mapping (it changes rarely). Coverage is incomplete by search alone (e.g. no MSF.MU/MSF.SG in the results, although they exist), so also probe tickers directly only with the same equivalence test. Verified mapping examples: MSF.DE, MSF.F, APC.DE, NVD.DE, ASME.DE, ASML.AS. Not tested: Euronext Paris/Milan lines for US stocks.

### 3.6 News (task 6)

No `news` module. `search(q,{newsCount:N})` returns `news[]`: `uuid, title, publisher, link, providerPublishTime (Date), type ("STORY"), thumbnail, relatedTickers[]`. Example (MSFT): `{"uuid":"8775f880-...","title":"Will Yum! Brands' (YUM) AI-Driven Operations ...","publisher":"Simply Wall St.","link":"https://finance.yahoo.com/technology/ai/articles/yum-brands-yum-ai-driven-071816930.html","providerPublishTime":"2026-10-15T07:18:16.000Z","type":"STORY","relatedTickers":["YUM","NVDA","MSFT"]}`.

| query | news returned | contains the symbol in `relatedTickers` | span |
|---|---|---|---|
| MSFT | 50 (newsCount 100 caps at 50) | 50 | newest 07:18Z today, oldest 2026-10-14 |
| AAPL | 49 | 49 | 2026-10-14..15 |
| SAP (ADR ticker) | 50 | 41 | 2026-10-06..14 |
| `SAP SE` (name) | 20 | - | 2026-10-07..14 (fuzzy, generic market stories) |
| SAP.DE, 7203.T, 0700.HK, NESN.SW, ASML.AS, MC.PA, SIE.DE, RELIANCE.NS | **0** | 0 | - |

Other: `insights('MSFT')` has `sigDevs[]` (`{headline,date}`) and `reports[]` - small (1 and 2 items), not general news. Links go to finance.yahoo.com article pages (Yahoo-hosted syndication). Implication: news only via the US-style ticker (ADR/primary US line); always filter by `relatedTickers.includes(symbol)`; relatedTickers can include many unrelated names (stories mention several tickers). History depth is days, not months, so persist daily. Non-US names need a different news source.

### 3.7 Screener / universe discovery (task 7)

**(a) Library predefined screeners** (`t7a.ts`): `screener({scrIds, count:250})` works; documented `scrIds`: `aggressive_small_caps, conservative_foreign_funds, day_gainers, day_losers, growth_technology_stocks, high_yield_bond, most_actives, most_shorted_stocks, portfolio_anchors, small_cap_gainers, solid_large_growth_funds, solid_midcap_growth_funds, top_mutual_funds, undervalued_growth_stocks, undervalued_large_caps`. Results (total): most_actives 382, day_gainers 58, undervalued_large_caps 92, most_shorted_stocks 3846, growth_technology_stocks 60, aggressive_small_caps 469, portfolio_anchors 258, small_cap_gainers 20, undervalued_growth_stocks 249, day_losers 516, top_mutual_funds 1749, conservative_foreign_funds 152, high_yield_bond 53, solid_large_growth_funds 153, solid_midcap_growth_funds 98. All US-only: `region` option ignored (`most_actives` with `region: 'de'` or `'jp'` returned the same BAC,NVDA,CRWV...). `growth_technology_stocks` fails the library's result validation (`should match some schema in oneOf`) unless `{validateResult:false}` is passed as 3rd argument. None are suitable for a market-cap universe.

**(b) Custom queries in the library: not supported.** Option type `ScreenerOptions = {lang, region, scrIds: PredefinedScreenerModules, count, start}`; the module calls only `https://${YF_QUERY_HOST}/v1/finance/screener/predefined/saved` (`screener.js`). grep for `intradaymarketcap|operands` in the package: only `screener.d.ts`/`screener.schema.js` (response schema of `rawCriteria`), no request-side support. GitHub issue #894 "Custom screener" (closed 2025-02-23): maintainer answered only that a (predefined) screener API exists and "needs a little love"; no custom-query support. Issue #991 (closed 2026-03-25) only added `start` pagination.

**(c) Raw custom screener endpoint (as used by Python yfinance): WORKS.** Auth: `GET https://fc.yahoo.com` (HTTP 404 but sets cookie `A3`) then `GET https://query1.finance.yahoo.com/v1/test/getcrumb` with that cookie -> HTTP 200, 11-char crumb (`$SPIKE\yfraw.ts`). Without crumb: HTTP 401 `{"error":{"code":"Unauthorized","description":"Invalid Crumb"}}`. The `query2` host works for the POST as well.

```
POST https://query1.finance.yahoo.com/v1/finance/screener?crumb=<crumb>&lang=en-US&region=US&formatted=false
{"size":250,"offset":0,"sortField":"intradaymarketcap","sortType":"DESC","quoteType":"EQUITY",
 "query":{"operator":"and","operands":[{"operator":"gt","operands":["intradaymarketcap",50000000000]},
                                        {"operator":"eq","operands":["region","us"]}]},"userId":"","userIdType":"guid"}
-> HTTP 200 {"finance":{"result":[{"start":0,"count":250,"total":632,"quotes":[...],"useRecords":false}],"error":null}}
```
Result quote fields (same family as `quote()`): `symbol, shortName/longName, quoteType, currency, marketCap, sharesOutstanding, regularMarketPrice/Time/Volume, exchange, fullExchangeName, market, marketState, exchangeTimezoneName, firstTradeDateMilliseconds, priceHint, region ("US" = request region, NOT the listing country), ...`. No sector, industry, country, ISIN, ADR flag.

**Threshold is applied in LOCAL (listing) currency**, evidence = lowest `marketCap` in each regional page-1 (sorted DESC): jp min 763,890,892,800 **JPY** (6370.T; = ~US$4.8B), in min 874,654,728,192 INR (AMBUJACEM.BO), kr min 1.699e12 KRW, br min 262.9e9 BRL, "WORLD" first page ended at 37.3e12 **IDR** (MEDC.JK) because the sort is by raw local numbers. i.e. `intradaymarketcap > 5e10` means 50e9 of whatever currency the stock trades in. `currency` as an operand is silently ignored (total unchanged at 12575).

Regional runs, one call each, size 250 (`t7d.ts`; raw `raw\screener_<reg>_p1.json`):
| region | total (>5e10 local) | returned | currencies / exchanges seen |
|---|---|---|---|
| us | 632 | 250 | USD; NasdaqGS 43, NYSE 107, **OTC (PNK/QX/ID) 100** in page 1 |
| de | 908 | 250 | EUR (+1 USD); XETRA 68, **Frankfurt 170**, Stuttgart 8, Munich 4 (duplicates of foreign primaries) |
| jp | 1359 | 250 | JPY; Tokyo |
| gb | 1219 | 250 | GBp 187, USD 26, SEK 15, EUR 7...; LSE 117, **Cboe UK 104, IOB 29** (foreign secondary lines) |
| hk | 211 | 211 | HKD; HKSE |
| in | 1645 | 250 | INR; BSE 127 + NSE 123 (same companies listed twice) |
| sa | 13 | 13 | SAR; Saudi |
| ch | 41 | 41 | CHF; Swiss |
| fr | 21 | 21 | EUR; Paris |
| nl | 6 | 6 | EUR; Amsterdam |
| kr | 1872 | 250 | KRW; KSE 204, KOSDAQ 46 |
| tw | 239 | 239 | TWD; Taiwan 197, Taipei Exchange 42 |
| cn | 339 | 250 | CNY; Shanghai 157, Shenzhen 93 |
| ca | 190 | 190 | CAD (+3 USD); Cboe CA 106, Toronto 84 |
| au | 13 | 13 | AUD; ASX |
| br | 512 | 250 | BRL; Sao Paulo (BDRs such as NIKE34.SA) |
| (no region = worldwide) | 12575 | 250 | mixed local currencies (IDR, ARS, VND, KRW, ...) |

Paging: `size` max **250** (`size 500` and `1000` -> HTTP 400 `"size is too large"`); `offset` paging works: US offsets 0/250/500 returned 250/250/132 = **632 unique symbols = total**; `offset` beyond total returns `count:0`; a 20,000-row walk of the worldwide result (offsets up to 19,750) raised no error (24,472 total at 1e10). Operators confirmed: `and`, `or`, `gt`, `eq` on `exchange` (NMS 89, NYQ 252, NGM 1, NMS-or-NYQ 341 at 5e10) and `sector` (US Technology 82).

**Recommended working design (tested, `t7g.ts`)**: one paged query PER EXCHANGE CODE with local threshold = `50e9 / FX x 0.7` (30% safety margin), then post-filter exactly with FX (`marketCap` in major currency units) -> `>= US$50B`. FX from `quote(['EURUSD=X', ...])` (38 currencies OK). Over 62 exchange codes (~100 requests at ~4/s) that returned 5,662 raw rows -> **2,882 rows >= US$50B** across 49 exchanges; after name-normalisation de-dup (`raw\universe_ge50B.json`) **526 distinct company names**, of which **486 have at least one non-secondary listing** (i.e. excluding VIE/FRA/STU/MUN/DUS/SAO/MEX/BUE/NEO/IOB/CXE). That matches the 400-600 target. US-listed rows on NMS/NYQ/NGM at >=US$50B: **321** (includes foreign ADRs such as TSM, HDB, BABA, NVO, SHEL, TM, SAP, AZN, TD, SHOP, ASML), versus 632 for `region=us` at the raw 5e10 (includes OTC lines). Rows >= US$50B by exchange (before dedup): NMS 89, NYQ 232, GER 253 (many are secondary lines of US names), LSE 75, EBS 43, TOR 34, HKG 36, JPX 29, SHH 26, SES 12, TAI 11, ASX 8, KSC 7, NSI 6, AMS 6, MIL 6, SAU 5, PAR 17, JNB 7.

Duplicates / ADRs: every large US company also appears as `.NE`, `.TO` (CDRs), `.DE/.F/.SG/.MU/.DU/.HM`, `.VI`, `.SW`, `.SA` (BDR `AAPL34.SA`), `.MX`, `.WA`, `.BA`, `.BK`, `.CL` lines (16-23 lines per US mega-cap, e.g. Alphabet 23). Secondary lines carry the underlying company's market cap and sharesOutstanding (MSFT.MX 7.3e13 MXN). The screener has no ADR flag and no country: US ADRs of foreign firms appear as plain EQUITY on NYQ/NMS (TSM, ASML...). ADR-vs-ordinary must be derived from `quoteSummary.assetProfile.country` (non-US country + US exchange = ADR/US-listed foreign share), and same-company grouping from `longName` + `sharesOutstanding` equality. A dead-endpoint fallback (index constituents + quote filter) was not needed.

**Other discovery path verified**: `GET https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=2` returns 200 even WITHOUT a crumb; it is the library's endpoint.

### 3.8 Rate limiting (task 8)

- 60 sequential single-symbol `quote()` at a 250 ms cadence (`t8.ts`): 59 OK (the single "error" was my own script passing an undefined symbol), **0 HTTP errors, no 429**; elapsed 16.4 s (3.66 req/s); latency p50 95 ms, p95 153 ms, max 920 ms.
- 20 `chart()` (period1 2014) at 500 ms cadence: 20 OK, 0 errors, 10.2 s, latency p50 248 ms, max 371 ms.
- Raw screener: ~100 POSTs at ~4/s (exchange sweep) and ~80 pages at ~4/s (world walk): all HTTP 200. Bulk quote 1500 symbols: 1.7 s.
- Total requests in the spike were a few hundred over ~75 minutes, never more than ~4-5 req/s; 429 was never observed, so the actual limit is **not established** (we stayed at <=5 req/s by design). The library has no retry/backoff: a 429 would surface as `HTTPError` with `code=429`.
- Crumb handling: library obtains cookie+crumb from `finance.yahoo.com/quote/AAPL`, in-memory jar; no `validation` errors on quote/chart/quoteSummary/search; `suppressNotices: ["yahooSurvey"]` removes the one-time survey notice; `ripHistorical` applies to `historical()` only; `screener()` needed `validateResult:false` for `growth_technology_stocks`.
- CPU proxy (Node, `cpu.mjs`, 5 charts / 1 quote of 500): `chart` ~37 ms CPU per 11-year call with validation (12 ms with `validateResult:false`); `quote` 500 symbols ~220 ms CPU (94 ms unvalidated).

### 3.9 Deno and Supabase Edge Runtime (task 9)

(a) `npm i -g deno` -> Deno 2.9.6. `deno run -A main.ts` (`$SPIKE\denotest\main.ts`, `import YahooFinance from "npm:yahoo-finance2"`): quote(AAPL) 1155 ms, chart(SAP.DE) 3249 bars 339 ms, search(US5949181045) -> [MSFT] 367 ms; whole run 2.9 s. No missing Node API, cookie jar worked, no warnings.

(b) `bunx supabase init` in `$SPIKE\sb`; `functions serve` first failed with `{"code":"ServeLocalDbNotRunningError","message":"supabase start is not running."}` so `bunx supabase start -x gotrue,realtime,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,logflare,vector,supavisor` was needed first (images pulled in a few minutes; `docker ps`: `public.ecr.aws/supabase/edge-runtime:v1.77.4`, kong 2.8.1, postgres 17.11.0.004). Then `bunx supabase functions serve --no-verify-jwt`:
```
Using supabase-edge-runtime-1.77.4 (compatible with Deno v2.1.4)
curl http://127.0.0.1:54321/functions/v1/yf-spike   (cold, 5.3 s wall incl. npm module load)
{"deno":{"deno":"supabase-edge-runtime-1.77.4 (compatible with Deno v2.1.4)","v8":"11.6.189.12","typescript":"5.1.6"},
 "quote":{"ms":1322,"symbol":"AAPL","price":342.96},
 "chart":{"ms":272,"bars":3249,"first":"2014-01-02T08:00:00.000Z","last":"2026-10-15T07:00:00.000Z"},
 "search":{"ms":484,"symbols":["MSFT"]}}
```
Second call: quote 2114 ms (crumb acquired again, new jar), chart 271 ms, search 244 ms. Log warning on every request: `[Warning] [yahoo-finance2] Unsupported environment: Requires Deno >= 2.0.0, found supabase-edge-runtime-1.77.4 (compatible with Deno v2.1.4)... Things might break or work unexpectedly!` - cosmetic (runtime string not parsed), nothing broke. Heavy test (`?mode=heavy&n=12&syms=<500 symbols>`): 12 sequential 11-year `chart()` calls (200 ms pauses) chartMs `[295,210,1324,272,269,246,270,316,230,276,218,290]`, bars 3143-3274 each, plus one 500-symbol `quote()` 853 ms returning 500; total 7.5 s wall; heap 18 MB used / 25 MB total; no memory/CPU warning in the local log (grep of `serve.log` for cpu/memory/limit/wall: 0 hits). `Deno.cpuUsage` is unavailable in this runtime and the hosted 2 s CPU / 150 s wall limits are NOT enforced by `functions serve`, so **the CPU limit was not verifiable locally**; the Node CPU proxy (3.8) suggests ~40-60 ms CPU per chart incl. JSON parsing/validation, i.e. ~25-40 charts per invocation under 2 s CPU, minus cold-start module load (zod, MCP SDK, tough-cookie). Plan on <=15-20 charts per invocation or fan out. The esm.sh and hand-rolled fetch fallbacks were not needed because the library worked in the Edge Runtime; the hand-rolled cookie/crumb flow was demonstrated in plain Bun (`yfraw.ts`: fc.yahoo.com -> getcrumb -> screener POST) but not inside the Edge Runtime. Stack stopped with `bunx supabase stop --no-backup`; serve process killed.

### 3.10 Deep links (task 10)

curl with a desktop UA, `-L`, HTTP status + `<title>`:
| URL | HTTP | title |
|---|---|---|
| `https://finance.yahoo.com/quote/MSF.DE/` | 200 | Microsoft Corporation (MSF.DE) Stock Price, News, Quote & History - Yahoo Finance |
| `https://www.tradingview.com/symbols/XETR-MSF/` | 200 | MSF Stock Price and Chart - XETR:MSF - TradingView |
| `https://www.tradingview.com/symbols/NASDAQ-MSFT/` | 200 | Microsoft Stock Price - NASDAQ:MSFT Stock Chart - TradingView |
| `https://www.tradingview.com/chart/?symbol=XETR%3AMSF` | 200 | Live stock, index, futures, Forex and Bitcoin charts on TradingView (generic title; app shell, symbol not validated server-side) |
| `https://www.tradingview.com/symbols/MSFT/` (no exchange) | **404** | Page not found - TradingView |

Negative controls (TradingView returns 404 for wrong pairs, so a 200 on `/symbols/` is meaningful): `NASDAQ-JPM`, `NYSE-ZZZQQ`, `HKEX-0700` (leading zero), `TSE-7203.T` and `XETR-SAP.DE` (Yahoo suffix) all 404.

## 4. Field-mapping tables

**quote() -> our needs**
| Need | Field |
|---|---|
| native currency | `currency` (minor units `GBp`, `ZAc`, `ILA`, `KWF` possible) |
| market cap (native) | `marketCap` (major currency unit) |
| timestamp | `regularMarketTime` (Date; per-listing last-trade time) |
| shares outstanding | `sharesOutstanding` (+ `impliedSharesOutstanding`) |
| exchange code / name | `exchange` (NMS, NYQ, GER, ...), `fullExchangeName` (NasdaqGS, XETRA, ...), `market` (`us_market`) |
| quote type | `quoteType` (`EQUITY`, `ETF`, `FUTURE`, ...) |
| first trade date | `firstTradeDateMilliseconds` (parsed to Date) |
| session state | `marketState` (REGULAR/PRE/PREPRE/POST/POSTPOST/CLOSED) |
| timezone | `exchangeTimezoneName`, `exchangeTimezoneShortName`, `gmtOffSetMilliseconds` |
| name | `longName`, `shortName`, `displayName` (sometimes) |
| fiscal currency | `financialCurrency` |
| ISIN / sector / country / ADR flag | absent |

**chart() -> our needs**: `quotes[]` {`date` (session-open UTC instant), `open, high, low, close` (split-adjusted), `adjclose` (split+dividend adjusted), `volume`}; `events.splits[]` {`date, numerator, denominator, splitRatio`}; `events.dividends[]` {`date, amount`}; `meta` {`currency, exchangeName, fullExchangeName, exchangeTimezoneName, gmtoffset, firstTradeDate, regularMarketTime, currentTradingPeriod.regular{start,end}, priceHint, instrumentType, longName, validRanges`}.

**quoteSummary / search**: see 3.4 and 3.5 tables (sector/industry/country/summary only from quoteSummary `assetProfile` or search `sector`/`industry`).

## 5. Observed limits

| Item | Observation |
|---|---|
| quote batch | 2500 symbols/call OK; 4000 -> HTTP 414 (URI length). 1500 symbols = 3.6 MB JSON, 1.7 s |
| screener page | size <= 250 (500 -> 400 "size is too large"); offset paging to >= 19,750 worked |
| chart 11 y daily | ~3200 bars, 200-600 ms, ~330 ms typical |
| search | `quotesCount` 25 tested; `newsCount` capped at 50 |
| Request pace | up to ~4/s sustained with 0 errors; 429 threshold not reached |
| Library queue | `concurrency: 4`, no throttling/retry |
| Edge Runtime | edge-runtime 1.77.4, Deno 2.1.4-compat, 7.5 s wall for 12 charts + 500-quote; CPU cap not testable locally |
| quoteSummary | 11 KB for the 7 modules requested, 95-820 ms |

## 6. Licence and disclaimer (verbatim)

`node_modules/yahoo-finance2/LICENSE` (MIT; package.json `"license": "MIT"`):
```
Copyright 2021 Gadi Cohen

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
README header: "Copyright (c) 2021 by Gadi Cohen and Pilwon Huh. [MIT licensed](./LICENSE)."

README section "Unofficial API":
> This project is neither created nor endorsed by Yahoo Inc. Yahoo does not
> provide any official API to developers, nor makes any guarantees regarding
> service availability or API consistency. In practice however, the open source
> community has kept this project (and it's predecessor) working well since 2013.
>
> Nevertheless, we make no guarantees and you use this package at your own risk.
> The developers (and obviously Yahoo) cannot be held responsible for any losses
> you may incur as a result of using this service. Use of this package is
> considered acknowledgement and acceptance of these terms and of its license.

README also warns: "Be aware that if a stock gets delisted, Yahoo removes all related data, including historical (and chart) data from periods _before_ the delisting occurred (i.e. queries that worked before will start failing, and there is no way to retrieve this data again)." Yahoo's own terms of service for the data were not reviewed in this spike (data redistribution rights are a separate question).

## 7. Deep-link table

Patterns: Yahoo `https://finance.yahoo.com/quote/<yahooSymbol>/`; TradingView `https://www.tradingview.com/symbols/<PREFIX>-<ticker>/` or `https://www.tradingview.com/chart/?symbol=<PREFIX>%3A<ticker>`. The TradingView ticker is the Yahoo symbol WITHOUT the suffix and WITHOUT leading zeros (0700.HK -> HKEX:700). Share-class tickers such as `BRK-B` (TradingView uses `BRK.B`) were not tested.

| Yahoo `exchange` (fullExchangeName) | TradingView prefix | Tested URL | Status |
|---|---|---|---|
| NMS (NasdaqGS) | NASDAQ | NASDAQ-MSFT 200 | **verified** |
| NYQ (NYSE) | NYSE | NYSE-JPM 200 | **verified** |
| GER (XETRA) | XETR | XETR-MSF 200 | **verified** |
| FRA (Frankfurt) | FWB | FWB-MSF 200 | **verified** |
| AMS (Amsterdam) | EURONEXT | EURONEXT-ASML 200 | **verified** |
| PAR (Paris) | EURONEXT | EURONEXT-MC 200 | **verified** |
| MIL (Milan) | MIL (not EURONEXT) | MIL-ENI 200 | **verified** (prefix is `MIL`) |
| LSE (LSE) | LSE | LSE-SHEL 200 | **verified** |
| JPX (Tokyo) | TSE | TSE-7203 200 | **verified** |
| HKG (HKSE) | HKEX | HKEX-700 200 (HKEX-0700 404) | **verified**, strip leading zeros |
| NSI (NSE) | NSE | NSE-RELIANCE 200 | **verified** |
| SAU (Saudi) | TADAWUL | TADAWUL-2222 200 | **verified** |
| EBS (Swiss) | SIX | SIX-NESN 200 | **verified** |
| SES (SES) | SGX | SGX-D05 200 | **verified** |
| KSC (KSE) | KRX | KRX-005930 200 | **verified** |
| TAI (Taiwan) | TWSE | TWSE-2330 200 | **verified** |
| SHH (Shanghai) | SSE | SSE-600519 200 | **verified** |
| SHZ (Shenzhen) | SZSE | SZSE-000858 200 | **verified** |
| TOR (Toronto) | TSX | TSX-TD 200 | **verified** |
| ASX (ASX) | ASX | ASX-BHP 200 | **verified** |
| SAO (Sao Paulo) | BMFBOVESPA | BMFBOVESPA-VALE3 200 | **verified** |
| MEX (Mexico) | BMV | BMV-AAPL 200 | **verified** |
| JNB (Johannesburg) | JSE | JSE-NPN 200 | **verified** |

Unverified (not tested, plausible only): KOE (KOSDAQ -> KRX), BSE (-> BSE), TWO (-> TPEX), NGM/NCM (-> NASDAQ), PCX (-> NYSEARCA), ASE (-> AMEX), VIE, STO, HEL, CPH, OSL, WSE, TLV, IST. A 200 proves that the symbol page exists, not that it is the same share class.

## 8. Risks and recommended client design

Risks: (1) unofficial scraping-grade API, breakage and Yahoo ToS exposure (no SLA, data redistribution rights unclear); (2) crumb/cookie must be re-acquired per cold start (+1-2 s, extra requests; Edge isolates are short-lived); (3) schema drift (library validation errors; its tracker has frequent "API drift" fixes, e.g. #1030 closed 2026-10-14); (4) data quality: null OHLCV rows, minor currency units, `marketCap` currency semantics, secondary listings carrying the primary's market cap; (5) screener threshold in local currency; (6) news absent for non-US tickers; (7) no ISIN; (8) 429 limit unknown; (9) delisted symbols lose history.

Recommended design:
- One small `YahooClient` wrapper (library for quote/chart/quoteSummary/search; hand-rolled fetch only for the custom screener, which the library lacks). Share one `YahooFinance` instance and cookie jar per invocation; consider persisting cookies+crumb (`cookieJar` option, tough-cookie) in the DB/KV to skip the crumb dance; refresh the crumb on HTTP 401 `Invalid Crumb`.
- Throttle globally to <=3-4 req/s (queue concurrency 1-2 with 250-300 ms spacing), retry with exponential backoff + jitter on 429/5xx/network errors, honour `Retry-After`, circuit-break on repeated 429; never fan out many Edge invocations at once.
- Batch: `quote()` in chunks of <=500-1000 symbols with `fields` limited; chart per symbol, <=15-20 per Edge invocation (CPU), schedule in slices; use `validateResult:false` plus own checks on the needed fields to cut CPU.
- Universe: weekly job, per-exchange screener sweep with FX-derived local thresholds, dedupe by company (normalised longName + sharesOutstanding + market-cap equality), classify home vs secondary listing via `assetProfile.country` and exchange, store primary symbol and alias set; US subset = NMS/NYQ/NGM rows (mark foreign ADRs via country).
- Daily bars: store `close`/OHLC (split-adjusted), optionally `adjclose`; apply the completed/forming rule before persisting; skip null rows; refetch the last ~5 bars each run to absorb corrections; refetch full history when a new split event appears; derive the trading date in the exchange timezone.
- Caching: cache search/ISIN mapping and quoteSummary profile for days-weeks; cache FX for the run; persist news daily (history is only days).
- Observability: log HTTP status, latency, count per call; alert on empty/partial responses (`quote()` silently omits unknown symbols).
- Keep the provider interface swappable (see `market-data-providers.md`) since everything is unofficial.

## 9. Files saved in the spike dir (`$SPIKE`)

- Scripts: `t1.ts` (v2/v3 notes, historical), `t2.ts`/`t2b.ts` (chart + adjustment proof), `t3.ts`/`t3b.ts`/`t3c.ts` (quote bulk and limits), `t4.ts` (quoteSummary), `t5.ts`/`t5b.ts` (search/ISIN/EUR lines), `t6.ts`/`t6b.ts` (news), `t7a.ts` (predefined screeners), `t7c.ts`-`t7h.ts` + `yfraw.ts` (raw custom screener, regions, paging, per-exchange universe), `t8.ts` (rate test), `cpu.mjs` (CPU proxy), `denotest\main.ts`, `sb\supabase\functions\yf-spike\index.ts`, `sb\serve.log`, `sb\start.log`.
- Raw data `raw\`: `chart_<SYM>.json` x8 (full chart responses), `quote_50.json`, `quoteSummary_MSFT.json`, `quoteSummary_SAP.DE.json`, `search_*.json` x3, `news_*.json` x4, `screener_most_actives.json`, `screener_custom_us_p1.json`, `screener_<region>_p1.json` x17, `fx.json`, `world_10e9.json` (20,000 world rows at local threshold 1e10), `universe_raw.json` (5,662 rows), `universe_ge50B.json` (2,882 rows with `mcUsd`).
