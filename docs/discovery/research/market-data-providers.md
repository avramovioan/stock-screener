# Market-data providers for a public stock-screening site (research notes)

Research date / "accessed" date for every source: **2026-10-15**. Method: official pricing, docs and terms pages fetched where reachable; where a page returned HTTP 403/404 the claim is marked *search-snippet only* or *Unverified*. No code was written. Prices are as shown on the fetched page (no VAT; currency as stated).

## 1. Executive summary

**Central finding: legal display rights, not data coverage, decide the choice.** Every provider whose terms I could read restricts personal/individual plans to private or internal use and prohibits public display. Public pages showing prices, candles or market caps are "display", so cases (a) and (b) both hit this wall (a public site is not "personal use" even if free of charge).

| Item | Verdict |
|---|---|
| **Recommended primary (technical)** | **EODHD (EOD Historical Data)**. Only provider verified to have: global screener with market-cap filter, whole-exchange bulk EOD (100 calls/exchange/day), splits endpoint, ISIN/LEI/CIK/PrimaryTicker/IPODate/Type fields in fundamentals, news endpoint, 100,000 calls/day, 30+ years history. |
| **Cheapest tier covering all technical needs** | EODHD **ALL-IN-ONE: US$99.99/month (US$83.33/month billed annually, US$999.90/yr)**, personal licence. Screener is listed under Active Trader (US$29.99) and historical market cap/fundamentals under Equity Analyst (US$59.99); which exact tier unlocks bulk `filter=extended` market cap is **Unverified**, so ALL-IN-ONE is the only tier verified to include everything. |
| **Legal reality of that tier** | Personal plan terms forbid display (quoted below). Using it for a **public** site is **not permitted**. Cheapest *verified* EODHD licence with display rights in sight: **Enterprise US$2,499/month (US$24,990/yr)** (data services agreement; display rights per search snippet). Internal Use (US$399/mo) explicitly forbids external display. |
| **Runner-up** | **Financial Modeling Prep (FMP)**: Ultimate plan has global coverage and bulk (US$149/mo annual-billed, search-snippet only; official page returned 403). Display needs a custom "Data Display and Licensing Agreement" (no published price). |
| **Yahoo Finance** | **Do not use in production.** No official API; ToS prohibits automated access and commercial use (quotes in 2.1). Decision: NO-GO for both cases (a) and (b). |
| Free legal identity/FX helpers | OpenFIGI, GLEIF (CC0), SEC EDGAR, Frankfurter usable at zero cost (details in 2.14). |

**Pragmatic proposal for the lead to decide:** (1) use EODHD for engine data (ALL-IN-ONE, about US$100/mo) only for non-public computation and publish only derived analytics (rank, regression slope/channel stats) after written confirmation from EODHD that derived outputs are allowed; (2) for public Quotes-page candles, use a provider-supplied embeddable widget or negotiate a display licence (EODHD Enterprise / FMP display agreement / Twelve Data Redistribution add-on) before launch. Whether derived analytics count as "displaying the Information" is a legal question **I could not verify**; ask the provider in writing.

## 2. Per-provider findings (requirements 1-10)

### 2.1 Yahoo Finance
- **Official API:** none. A secondary source states Yahoo shut the old API on 15 May 2017 and never replaced it, and that yfinance uses the same unofficial endpoints as the Yahoo site - [Scrapfly guide](https://scrapfly.io/blog/guide-to-yahoo-finance-api/) (secondary).
- **ToS** (Yahoo Terms of Service, effective 6 May 2025 / US terms dated 15 May 2025) - [Yahoo ToS](https://legal.yahoo.com/us/en/frontier/terms/otos/index.html). Clauses as returned by the page reader (re-check the page before legal reliance):
  - "access or collect data, or attempt to access or collect data, from our Services using any automated means, devices, programs, algorithms or methodologies, including but not limited to robots, spiders, scrapers, data mining tools, or data gathering or extraction tools, for any purpose without our express, prior permission."
  - "use any material or content from, including without limitation any data, (a) to create any database, archive, mobile application, data feed, widget or any other aggregated data source that competes with or constitutes a material substitute for the Services"
  - "Unless otherwise expressly stated, you may not access or reuse the Services, or any portion thereof, for any commercial purpose."
  - APIs: "we grant you a personal, royalty-free, non-transferable, non-assignable, revocable, and non-exclusive license to use the software and APIs we may provide to you as part of the Services" (personal use).
- **yfinance README disclaimer** - [GitHub ranaroussi/yfinance](https://github.com/ranaroussi/yfinance): "yfinance is **not** affiliated, endorsed, or vetted by Yahoo, Inc. It's an open-source tool that uses Yahoo's publicly available APIs, and is intended for research and educational purposes." ... "Remember - the Yahoo! finance API is intended for personal use only."
- **Breakage:** the crumb/cookie mechanism returns HTTP 429; users hit 429 after about 950 tickers (Nov 2024) and Portfolio Performance saw all quotes fail (Apr 2025) - [yfinance issue 2297](https://github.com/ranaroussi/yfinance/issues/2297), [Portfolio Performance forum](https://forum.portfolio-performance.info/t/yahoo-finance-to-many-requests-getting-errors-on-updates-desktop-only/32780).
- **Licensed Yahoo feed for small customers:** none found. Unverified (absence of evidence).
- **Verdict:** No-go (both cases). The terms ban automated collection without permission and commercial reuse, and the endpoint is unstable at 600 symbols. A public site is not covered by the "personal use" API licence.
- Yahoo field semantics (Close split-adjusted, Adj Close including dividends): no official Yahoo page found; **Unverified**.

### 2.2 EODHD (EOD Historical Data) - recommended technical fit
- **Plans** - [pricing](https://eodhd.com/pricing): Sandbox free (20 calls/day, 1 year history); Historian US$19.99/mo (US$199/yr); Active Trader US$29.99 (US$299.90/yr); Equity Analyst US$59.99 (US$599.90/yr); ALL-IN-ONE US$99.99 (US$999.90/yr). Paid: 100,000 calls/day, 1,000 req/min. The fetched page shows USD; a search snippet showed EUR for the same tiers (billing currency **Unverified**; check at checkout).
- **1 Universe:** Screener API, filters include market capitalization and exchange, 5 calls/request, max 500 rows/request, offset max 999 so no screen pages beyond the first 1,000 matches - [screener doc](https://eodhd.com/financial-apis/stock-market-screener-api). The screener is in the Active Trader tier in the pricing table. A cap >= US$50B worldwide is about 500 rows, which fits. Screener coverage of every required venue (Tadawul, JSE, etc.) and whether its market cap is USD or native: **Unverified**.
- **2 Market cap:** Fundamentals General has `MarketCapitalization`, `SharesOutstanding` - [fundamentals doc](https://eodhd.com/financial-apis/stock-etfs-fundamental-data-feeds). Bulk EOD with `filter=extended` adds market cap; "Market cap and beta reflect current values, not historical point-in-time data" - [bulk doc](https://eodhd.com/financial-apis/bulk-api-eod-splits-dividends). Historical market cap is listed under Equity Analyst. FX: forex data included from Historian; FX endpoint details not fetched.
- **3 Security master:** General fields ISIN, LEI, CIK, CUSIP, PrimaryTicker, IPODate, Type, IsDelisted, `HomeCategory` (Domestic/ADR) - [fundamentals doc](https://eodhd.com/financial-apis/stock-etfs-fundamental-data-feeds). The exchange symbol-list doc page returned 404 (Type value set **Unverified**). No FIGI seen. Share-class and EUR-line mapping by ISIN is derivable by our own join but not provided.
- **4 OHLCV:** `/api/eod/{SYMBOL}`, JSON/CSV, 30+ years. Docs state `close` = "Raw price as traded that day, unadjusted"; `adjusted_close` = "Adjusted for both stock splits and dividends"; volume adjusted for splits only; Apple 2020 example raw close 500.04 vs 125.01 - [EOD doc](https://eodhd.com/financial-apis/api-for-historical-data-and-volumes). **Important:** this contradicts my prior expectation that EODHD `close` is split-adjusted; run a live test on a known split before relying on it. Splits and dividends endpoints exist (1 call each). Split-only adjustment is done by us from raw close plus the splits endpoint. Bulk can return splits for a whole exchange per day.
- **5 Latest bar:** NYSE/Nasdaq updated "within 15 minutes after the market closes"; other venues "2-3 hours" (same doc). An exchange-details endpoint with trading hours/holidays exists (page not verified). No explicit "bar is final" flag found.
- **6 News:** `/news` returns date, title, content, link, symbols, tags, sentiment; 5 calls + 5 per ticker; no explicit source-name field listed (only link) - [news doc](https://eodhd.com/financial-apis/stock-market-financial-news-api).
- **7 Load:** daily either 1 bulk call per exchange (100 calls each, about 25 exchanges = about 2,500 calls) or 600 per-symbol EOD calls (1 call each = 600); both far below 100,000/day. Backfill 600 x 2,500 bars = 600 calls (full history in one response). Fundamentals 10 calls each = 6,000 for 600 symbols. Bulk US day = 44,376 rows, 2.3 MB CSV / 6.7 MB JSON - [bulk doc](https://eodhd.com/financial-apis/bulk-api-eod-splits-dividends); prefer CSV or `symbols` filter in Edge Functions. Call costs - [API limits](https://eodhd.com/financial-apis/api-limits): EOD/splits/dividends 1; news/screener/intraday 5; fundamentals 10; bulk 100+.
- **8 Legal:** [Terms](https://eodhd.com/financial-apis/terms-conditions): Non-Professional Users may "store, manipulate, and analyze the data for private, non-commercial purposes" but may not resell, retransmit, redistribute, display, or grant access to the Information or Services "whether in its original or repackaged form" (page-reader summary of two clauses, wording partly paraphrased). [Commercial pricing](https://eodhd.com/commercial-pricing): Internal Use US$399/mo (US$3,990/yr) - "data may only be used inside your company," external display prohibited; Enterprise US$2,499/mo (US$24,990/yr) includes a data services agreement; Custom from US$399/mo by quote. Attribution requirement: none stated. Exchange display-delay requirements: Unverified.
- **9 Price:** see section 1.
- **10 Edge fit:** plain HTTPS, `api_token` query parameter, JSON/CSV; no SDK needed. Good.

### 2.3 Financial Modeling Prep (FMP)
- The official pricing/terms pages returned HTTP 403 to my fetch; all FMP facts below come from search snippets of FMP pages.
- **Plans (snippet)** - [FMP plan-choice insight](https://site.financialmodelingprep.com/insights/platform/how-to-choose-the-right-financial-modeling-prep-plan-for-your-workflow), [pricing](https://site.financialmodelingprep.com/pricing-plans): annual-billed Starter US$22/mo (5 yrs history, US only, 300 calls/min), Premium US$59/mo (30 yrs, US/UK/Canada, 750/min), Ultimate US$149/mo (global coverage, bulk, 3,000/min); free Basic 250 calls/day. One search result said standard plans range "free to $99/month", which conflicts; Unverified, check the live page.
- **Universe:** a stock-screener endpoint (market-cap filter) is documented at the docs URL (page not readable). Global coverage only on Ultimate.
- **Legal (snippet)** - [FMP insight: public app/website](https://site.financialmodelingprep.com/insights/platform/can-you-use-fmp-data-in-a-public-app-website-or-client-dashboard): pricing table labels personal tiers "Licence - Personal"; terms restrict to "personal, non-business and non-commercial purposes only"; displaying or redistributing FMP-sourced data "requires a specific Data Display and Licensing Agreement"; no published price.
- Requirements 3-6, 10: Unverified in this pass (no readable docs).

### 2.4 Twelve Data
- **Plans** - [pricing](https://twelvedata.com/pricing): Basic free (8 credits/min, 800/day, "Global trial symbols only"); Grow US$79/mo (US$66/mo annual; 55 credits/min; "20+ markets", fundamentals); Pro US$229 (US$191 annual; 610/min; "70+ markets", EU real-time); Ultra US$999 ("All markets", 85 exchanges). "All plans cover personal, internal, non-commercial use."
- **Docs** - [docs](https://twelvedata.com/docs): time series `outputsize` max 5,000; `adjust` = all/splits/dividends/none, **default `splits`** (matches TradingView-style presentation); 1 credit per symbol; `/stocks` catalog; market cap via statistics endpoint; `/earliest_timestamp`; splits and dividends endpoints; header or `apikey=` auth; JSON/CSV.
- **Universe:** no worldwide market-cap screener verified (only `/stocks` listing plus per-symbol statistics). Existence of any screener: Unverified.
- **Legal** - [Terms](https://twelvedata.com/terms): "Access and use the Platform solely for Internal Use"; "Redistribute or provide external display of Data only if and as expressly authorized by a Redistribution Rights Add-On or separate written agreement"; "Store or cache Data beyond permitted timeframes specified in the Documentation" is prohibited; "all Data must be deleted within 30 days" after termination. Add-on price: not found.
- **Load:** backfill = 600 credits (2,500 bars < 5,000 per call), about 11 minutes on Grow at 55/min. Which tier lists all required venues (Tadawul, JSE, etc.): Unverified.

### 2.5 Finnhub
- Pricing page returned no plan data to my fetch. Search snippets only: free about 60 calls/min; international coverage on paid plans (about US$50-500+/mo, unverified); US candles reported denied on the free plan - [apicostcalc](https://apicostcalc.com/finnhub.html), [GitHub issue 546](https://github.com/finnhubio/Finnhub-API/issues/546). Company news exists on the free plan. All other requirements: Unverified.

### 2.6 Polygon.io -> Massive
- Rebranded to Massive.com on 30 Oct 2025 (secondary source: [apicostcalc](https://apicostcalc.com/blog/polygon-massive-rebrand-api-pricing.html)); api.polygon.io works in parallel.
- [Massive pricing](https://massive.com/pricing): Stocks Basic free (5 calls/min, 2 yrs, EOD, "Individual only"); Starter US$29 (5 yrs, 15-min delayed); Developer US$79 (10 yrs); Advanced US$199 (20+ yrs, real-time); all "All US Stocks Tickers", "Non-pros only". **Fails requirement 1: US only.** Useful at most for the US subset; business/display licence terms not on this page (Unverified).

### 2.7 Alpha Vantage
- [Premium](https://www.alphavantage.co/premium/): free 25 requests/day; premium US$49.99/mo (75/min) up to US$249.99 (1,200/min).
- [Docs](https://www.alphavantage.co/documentation/): TIME_SERIES_DAILY is raw/unadjusted, full history premium only; TIME_SERIES_DAILY_ADJUSTED premium (raw plus adjusted close plus split/dividend events); non-US via suffixes (.LON, .TRT, .DEX, .BSE, .SHH, .SHZ); LISTING_STATUS; NEWS_SENTIMENT; OVERVIEW has market cap. No worldwide market-cap screener. Display licence: Unverified.

### 2.8 Tiingo
- [Pricing](https://www.tiingo.com/about/pricing): Starter free (1,000 req/day, 50/hour, 500 symbols/month, 1 GB); Power US$30/mo individual, US$50/mo commercial-internal (10,000/hour, 100,000/day, 40 GB); 110,269 symbols (US and Chinese stocks 49,547). Quote: "Internal use means you may only use the data for your own personal use and you may not display or share the data with another person or organization." Redistribution is custom.
- [EOD docs](https://www.tiingo.com/documentation/end-of-day): raw OHLC plus adjOpen/High/Low/Close, volume, `divCash`, `splitFactor`; adjustments follow CRSP and "incorporate both split and dividend adjustments"; "Most US Equity prices are available at 5:30 PM EST". International coverage on the page is US plus Chinese only, so it **fails requirement 1**.

### 2.9 Marketstack
- [Plans](https://marketstack.com/product): Free 100 req/month; Basic US$9.99 (10,000/mo); Professional US$49.99 (100,000/mo); Business US$149.99. History 10 yrs (Free/Basic), 15+ (Pro and up); 30,000+ tickers, 70 exchanges; commercial use only on paid plans. Screener, market cap, security master, news, display licence: Unverified. 10 years on cheap tiers is borderline against 2,500 bars.

### 2.10 Intrinio
- Search snippets only ([Intrinio guides](https://intrinio.com/guides/starter-plan), [costbench](https://costbench.com/software/financial-data-terminals/intrinio/)): Individual US$150/mo, personal use only, no display, US-centric; Startup plan with commercial display from US$333/mo for six months then higher. Fails requirement 1 (global). Unverified in detail.

### 2.11 Nasdaq Data Link
- Search snippet ([help centre](https://help.data.nasdaq.com/article/568-how-much-does-nasdaq-data-link-data-cost-how-do-i-find-pricing)): free WIKI EOD frozen since April 2018; Sharadar SEP personal US$39/mo, US only. Fails requirement 1.

### 2.12 Stooq
- Search snippets only ([apievangelist](https://providers.apievangelist.com/providers/stooq/), [Stooq db](https://stooq.com/db/h/)): CSV via `stooq.com/q/d/l/`, API key via CAPTCHA as of early 2026, daily hit quota, bulk ZIPs for 12,000+ securities. Direct fetch of Stooq returned nothing. **ToS/licence: Unverified**; no market cap, security master or news. Not suitable as primary; no verified display permission.

### 2.13 Enterprise (not viable)
Refinitiv/LSEG, Bloomberg, FactSet, Morningstar: enterprise contracts, not viable for this project; not assessed.

### 2.14 Free identity and FX sources
- **OpenFIGI** - [docs](https://www.openfigi.com/api/documentation): without key mapping 25 req/min, 10 jobs/request; with key 25 req/6 s, 100 jobs/request; returns securityType/securityType2, exchCode, compositeFIGI, shareClassFIGI; key via `X-OPENFIGI-APIKEY`. Terms/licence page not read (Unverified).
- **GLEIF** - [API](https://www.gleif.org/en/lei-data/gleif-lei-look-up-api): LEI data under CC0; maps ISIN/BIC; rate limits not verified.
- **SEC EDGAR** - [Accessing EDGAR data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data): "Current max request rate: 10 requests/second."; must declare User-Agent (sample "Sample Company Name AdminContact@<sample company domain>.com"); `company_tickers.json` (ticker, CIK, name) and submissions API on data.sec.gov. US SEC filers only.
- **Frankfurter** - [docs](https://frankfurter.dev/docs/): no API key, "no quotas" (abuse rate limit), 223 currencies from 104 central banks/official sources, mid-market daily rates. The earlier "ECB-only" description appears outdated per this page. SAR/TWD etc. coverage: **Unverified**.
- **exchangerate.host** - [site](https://exchangerate.host/): free 100 requests/month, paid from US$14.99/mo; API key required; terms Unverified.
- **Open Exchange Rates** - [signup](https://openexchangerates.org/signup): free 1,000 req/mo, hourly, USD base only; Developer US$12/mo (10,000 req, all bases). Commercial-use terms Unverified.

## 3. Feasibility matrix

Columns: 1 Universe, 2 Market cap/FX, 3 Security master, 4 OHLCV/adjust, 5 Latest bar, 6 News, 7 Load, 8 Legal public display, 9 Price, 10 Edge fit.

| Provider | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Yahoo (unofficial) | Partial: unofficial screener | Partial: unstable | Partial: no ISIN verified | Partial: unlicensed | Unverified | Partial | No: 429 at scale | **No**: ToS bans | Free | Partial: crumb/cookie |
| EODHD | Yes: screener, bulk | Yes: fundamentals, bulk | Partial: ISIN/LEI/IPO, no FIGI | Yes: raw+adj, splits | Partial: 15min-3h after close | Yes | Yes | **No** personal; US$2,499 Ent. | US$99.99/mo tech; US$2,499 display | Yes |
| FMP | Partial: Ultimate only | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | **No**: display agreement | US$149/mo (snippet) | Unverified |
| Twelve Data | Partial: no screener | Partial: per-symbol | Unverified | Yes: adjust=splits default | Unverified | Unverified | Yes: 1 credit/symbol | **No**: add-on needed | US$79-229/mo | Yes |
| Finnhub | Unverified | Unverified | Unverified | Unverified | Unverified | Yes: company news | Unverified | Unverified | Unverified | Unverified |
| Polygon/Massive | No: US only | Partial | Partial | Yes: US only | Yes: US only | Unverified | Yes | Personal only | US$29-199/mo | Yes |
| Alpha Vantage | No: no screener | Partial: OVERVIEW | Partial: LISTING_STATUS | Partial: adjusted premium | Unverified | Yes: sentiment | Partial | Unverified | US$49.99+/mo | Yes |
| Tiingo | No: US+China | No | Partial | Yes: raw+splitFactor | Yes: US 5:30pm | Yes (Power) | Yes | **No**: internal only | US$30-50/mo | Yes |
| Marketstack | Partial: 70 exchanges | Unverified | Unverified | Partial: 10-yr cap | Unverified | No | Partial: monthly quota | Unverified | US$9.99-149.99/mo | Yes |
| Intrinio | No: US-centric | Partial | Partial | Partial | Unverified | Unverified | Unverified | **No** Individual | US$150/mo+ | Unverified |
| Nasdaq Data Link | No: US only | No | Partial | Partial | No | No | Partial | Unverified | US$39/mo | Partial |
| Stooq | No: no screener | No | No | Partial | Unverified | No | Partial: daily quota | Unverified | Free | Partial |
| OpenFIGI/GLEIF/SEC | Identity only | No | Yes: free | n/a | n/a | n/a | Yes | Yes*: see note | Free | Yes |

*GLEIF CC0 and SEC fair-access verified; OpenFIGI terms unread.

## 4. Gaps no provider fully fills, and derivation proposals

Record provenance for every derived field in a `field_provenance` table: `(entity, field, value, source, endpoint_or_url, retrieved_at, method, confidence)`; never overwrite without keeping history; `confidence` = verified / inferred / manual.

1. **Primary listing / primary exchange flag.** EODHD gives `PrimaryTicker` (field name verified; quality unverified); OpenFIGI gives compositeFIGI/shareClassFIGI and exchCode but no primary flag. Proposal: primary = EODHD `PrimaryTicker`, cross-checked against the issuer's home-country exchange (LEI jurisdiction from GLEIF) and highest 90-day average volume (own calculation); flag disagreements for manual review; store the manual decision.
2. **10-year listing date.** EODHD `IPODate` (may be empty or wrong). Proposal: derive `first_bar_date` from our own backfill and compare with IPODate; rule = at least 2,500 bars or listing date at least 10 years ago; record which source decided.
3. **Verified EUR equivalent.** Match by ISIN across EODHD exchange lists (XETRA, Amsterdam, Paris, Milan, etc.; EUR currency). Cross-validate with OpenFIGI (same shareClassFIGI) and require the EUR price within a tolerance of home price x FX; otherwise label "unverified".
4. **Operating company vs ETF/fund/ADR/preferred/REIT.** EODHD `Type`/`HomeCategory` (value sets unverified) plus OpenFIGI securityType2 (e.g. "Common Stock", "ADR"). Require both to agree on common stock; policy decision needed for REITs/trusts.
5. **Share classes and ADR-to-ordinary mapping.** OpenFIGI shareClassFIGI groups across countries; GLEIF/EDGAR LEI/CIK group by issuer. Company key = LEI (fallback CIK, then manual), security key = FIGI; policy needed for summing multi-class caps.
6. **Ticker-change and corporate-action history.** Splits/dividends available (EODHD); ticker-change history not verified in any provider. Key identity on FIGI/ISIN, store ticker per validity period from daily listing snapshots; detect splits daily from the splits endpoint and refetch full history only for affected symbols.
7. **Market cap in USD with timestamp.** Providers give current market cap; compute our own `market_cap_usd = shares_outstanding x close x fx` at bar date and record share-count source and date.
8. **Bar finality.** No provider flag found. Use per-exchange calendar and close time plus provider delay (15 min US, 2-3 h elsewhere per EODHD); treat final only after the delay with volume > 0 and date equal to the session date.

## 5. TradingView adjustment-policy note

- **The official TradingView help pages I could fetch do not state the default.** [How to adjust data for dividends](https://www.tradingview.com/support/solutions/43000590597-how-to-adjust-data-for-dividends/): "A dividend-adjusted chart displays total shareholder return by incorporating the paid dividend into the share price" (page-reader paraphrase) and the user enables "Adjust data for dividends" in Supercharts settings. This implies dividend adjustment is off by default but the page does not say so. [How to configure your Supercharts](https://tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts) gave no default either.
- A secondary, non-official article says default TradingView data adjusts for splits/reverse splits and special distributions but not ordinary dividends - [Trend Investor Pro](https://trendinvestorpro.com/ordinary-dividends-to-adjust-for-or-not-to-adjust/). Treat the default as "splits adjusted, dividends not adjusted", **Unverified from official docs**.
- **Provider field mapping:** EODHD `close` is documented as raw (apply splits ourselves from the splits endpoint); `adjusted_close` includes dividends and must not be used for charts. Twelve Data `adjust=splits` (default) matches directly. Tiingo `adjClose` includes dividends (CRSP) but `splitFactor` allows a split-only series. Alpha Vantage: raw `close` plus premium split events.

## 6. Open questions and risks

1. **Legal blocker (biggest):** no verified inexpensive licence permits public display. Ask EODHD, FMP and Twelve Data in writing (i) whether displaying derived analytics (rank, regression channel) is permitted on a personal plan, (ii) the price of a display licence for a non-commercial hobby site.
2. EODHD `close` raw vs split-adjusted: run a live split test.
3. EODHD screener coverage per exchange (Tadawul, JSE, Indonesia, Thailand), currency of its market-cap field, tier entitlements, and billing currency (USD page vs EUR snippet).
4. FMP, Finnhub, Marketstack, Stooq, Intrinio: official docs unreadable (403/empty); cells marked Unverified.
5. Confirm with the product owner the rule for companies with fewer than 2,500 bars.
6. Policy choices: REITs/trusts as operating companies; multi-class cap aggregation; ADR vs ordinary preference.
7. TradingView default adjustment not verified from an official page.
8. Frankfurter currency coverage (SAR, TWD, etc.) unverified; Open Exchange Rates is a fallback.
9. Edge Function limits (timeout, memory) untested against large bulk responses.

## 7. Source list (all accessed 2026-10-15)

- Yahoo Terms of Service (effective 6 May 2025) - https://legal.yahoo.com/us/en/frontier/terms/otos/index.html
- yfinance README - https://github.com/ranaroussi/yfinance
- yfinance issue 2297 - https://github.com/ranaroussi/yfinance/issues/2297
- Portfolio Performance forum, Yahoo 429 - https://forum.portfolio-performance.info/t/yahoo-finance-to-many-requests-getting-errors-on-updates-desktop-only/32780
- Scrapfly, Guide to Yahoo Finance API - https://scrapfly.io/blog/guide-to-yahoo-finance-api/
- EODHD pricing - https://eodhd.com/pricing
- EODHD commercial pricing - https://eodhd.com/commercial-pricing
- EODHD terms and conditions - https://eodhd.com/financial-apis/terms-conditions
- EODHD API limits - https://eodhd.com/financial-apis/api-limits
- EODHD screener - https://eodhd.com/financial-apis/stock-market-screener-api
- EODHD EOD historical API - https://eodhd.com/financial-apis/api-for-historical-data-and-volumes
- EODHD bulk API - https://eodhd.com/financial-apis/bulk-api-eod-splits-dividends
- EODHD fundamentals - https://eodhd.com/financial-apis/stock-etfs-fundamental-data-feeds
- EODHD news - https://eodhd.com/financial-apis/stock-market-financial-news-api
- FMP pricing (403; snippet only) - https://site.financialmodelingprep.com/pricing-plans
- FMP plan-choice insight (snippet) - https://site.financialmodelingprep.com/insights/platform/how-to-choose-the-right-financial-modeling-prep-plan-for-your-workflow
- FMP public-app insight (snippet) - https://site.financialmodelingprep.com/insights/platform/can-you-use-fmp-data-in-a-public-app-website-or-client-dashboard
- Twelve Data pricing - https://twelvedata.com/pricing
- Twelve Data docs - https://twelvedata.com/docs
- Twelve Data terms - https://twelvedata.com/terms
- Massive (ex-Polygon) pricing - https://massive.com/pricing
- Polygon to Massive rebrand (secondary) - https://apicostcalc.com/blog/polygon-massive-rebrand-api-pricing.html
- Alpha Vantage premium - https://www.alphavantage.co/premium/
- Alpha Vantage docs - https://www.alphavantage.co/documentation/
- Tiingo pricing - https://www.tiingo.com/about/pricing
- Tiingo EOD docs - https://www.tiingo.com/documentation/end-of-day
- Marketstack plans - https://marketstack.com/product
- Finnhub (snippets) - https://apicostcalc.com/finnhub.html ; https://github.com/finnhubio/Finnhub-API/issues/546
- Intrinio (snippets) - https://intrinio.com/guides/starter-plan ; https://costbench.com/software/financial-data-terminals/intrinio/
- Nasdaq Data Link help - https://help.data.nasdaq.com/article/568-how-much-does-nasdaq-data-link-data-cost-how-do-i-find-pricing
- Stooq (snippets) - https://providers.apievangelist.com/providers/stooq/ ; https://stooq.com/db/h/
- OpenFIGI API docs - https://www.openfigi.com/api/documentation
- GLEIF API - https://www.gleif.org/en/lei-data/gleif-lei-look-up-api
- SEC EDGAR access - https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
- Frankfurter docs - https://frankfurter.dev/docs/
- exchangerate.host - https://exchangerate.host/
- Open Exchange Rates - https://openexchangerates.org/signup
- TradingView, How to adjust data for dividends - https://www.tradingview.com/support/solutions/43000590597-how-to-adjust-data-for-dividends/
- TradingView, How to configure Supercharts - https://tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts
- Trend Investor Pro (secondary, TradingView defaults) - https://trendinvestorpro.com/ordinary-dividends-to-adjust-for-or-not-to-adjust/
