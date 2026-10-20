# IBKR: Flex Web Service, deep links, iBot prompts and Xetra/AEB codes

Research date: 2026-10-15 (all "accessed" dates below are 2026-10-15 unless stated). No code written. Complements, and does not repeat, `ibkr-feasibility.md` (its sections 4C and 5 cover the basic Flex enable/call flow).

Method: IBKR pages that 403 to WebFetch were fetched with `curl -sL -A "Mozilla/5.0 ..."`. Flex docs come from the `www.interactivebrokers.com/docs/web-api/...md` variants (the `ibkrcampus.com/docs/...md` host returned a Cloudflare 1000/403 error to me). Field lists come from IBKR's Reporting Guide (`guides.interactivebrokers.com/reportingreference/reportguide/*.htm`). Anything I could not read from a primary IBKR source is marked **UNVERIFIED**.

---

## 1. Executive summary

**What the app can and cannot do without the trading API**
- CAN (Flex, read-only, no session/2FA): positions with FIFO cost basis and unrealized P/L, executions with commission and FIFO realized P/L, closed lots, dividends and withholding tax, transfers, corporate actions, FX rates per date, NAV, base currency. Everything is **end-of-day data** (T+1 for Activity queries).
- CANNOT: live/intraday prices, real-time positions, placing/modifying orders, knowing whether an order was filled minutes ago (only a Trade Confirmation query, ~5-10 min lag, is "intraday", see 2.4).
- Live prices must come from another source (e.g. Yahoo) and be combined with Flex positions in the app.

**Link strategy (verified findings)**
- IBKR publishes **no documented URL parameters** for opening a given instrument in Client Portal. I searched IBKR docs and the web; nothing found. The URL shapes `portal.interactivebrokers.com/portal/?action=QUOTE&conid=...` and `.../portal/#/quote/{conid}` return the Client Portal SPA shell (HTTP 200, title "Client Portal"), but that proves nothing: the server returns the same shell for any query string and never sees the `#` fragment. Whether the SPA honours them after login is **UNVERIFIED** (needs a logged-in browser test by the owner).
- Recommended fallback: link to `https://www.interactivebrokers.com/sso/Login` (HTTP 200, title "Login"; redirects to the entity domain, e.g. `.ie`) or `https://www.interactivebrokers.com/portal`, show symbol + exchange + conid + currency, and a copy button for the iBot prompt.
- Login-free conid lookup IS possible: IBKR's public "Products, Exchanges and Contracts Search" page is backed by unauthenticated JSON endpoints (`/webrest/...`, section 4). Microsoft on Xetra resolves to `MSF`, conid `12178239`, ISIN `US5949181045`, EUR. These are undocumented internal endpoints; permission to use them programmatically is **UNVERIFIED** (website terms not found).

**iBot prompt template (to generate)**
`Buy 10 shares of {LOCALSYMBOL} at {PRICE} limit` (documented-style grammar), then set the destination on the iBot order ticket (IBIS first, AEB second). The owner's sentence with "set destination IBIS2" is not covered by any IBKR documentation I found (section 5).

**Destination priority Xetra -> AEB (codes)**
- Xetra: `IBIS` (verified in IBKR's public exchange catalogue and fee page). `IBIS2` is **not** in IBKR's public exchange catalogue and I found no IBKR primary source defining it; only third-party sites call it Xetra / the Xetra ETF segment. Treat IBIS2 as UNVERIFIED.
- Euronext Amsterdam: `AEB` (verified: "Amsterdamse Effectenbeurs").
- `SMART` is not in the product catalogue (it is a routing mode, not an exchange): UNVERIFIED in a primary source in this run (the earlier report cites an IBKR doc example `265598@SMART`).

---

## 2. Flex Web Service

### 2.1 User setup checklist

1. Client Portal: Performance & Reports (or Menu) -> Reporting -> Flex Queries. Source: https://www.ibkrguides.com/clientportal/performanceandstatements/flex.htm (accessed 2026-10-15, page updated Oct 30, 2025).
2. Create an **Activity Flex Query**: "+" icon at the top right of "Activity Flex Query", enter a name, click each Section to include, pick fields per section in the pop-up, drag to reorder, Save; in "Delivery Configuration" choose Accounts, Models, Format ("XML, CSV, Text (Pipe) or Text (Tab)") and Period; set General Configuration; Continue, Create. Source: https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm (page updated July 22, 2026).
3. Note the **Query ID**: click the Info icon beside the query; "capture the Query ID number listed at the top". Source: https://www.interactivebrokers.com/docs/web-api/flex-web-service/client-portal-configuration/create-a-flex-query.md
4. Flex Web Service Configuration (right-hand panel on the Flex Queries page): tick "Flex Web Service Status", Save; this provides "Current Token". "You also have the option to generate a new token. A token can be specified to remain active anywhere between 6 hours and 1 year. Generating a new token also allows users to restrict which IPs can make flex web service requests." Source: https://www.interactivebrokers.com/docs/web-api/flex-web-service/client-portal-configuration/enable-and-create-access-token.md
5. For multi-account/advisor structures: "The Flex Web Service Token may be used to retrieve reporting data for all linked accounts, dependent on account inclusion during flex query generation." (same page). Irrelevant for one personal account, but it shows the token is not scoped to one query.
6. Saved Flex queries "are available for the four previous calendar years and from the start of the current calendar year" (flex.htm above).
7. Token security: IBKR docs describe no read/write distinction; Flex has no trading endpoints (Intro: "a small, standalone HTTP API for programmatically generating and retrieving pre-configured Flex Queries"). The token still exposes full account activity: treat it as a secret, pick the shortest lifetime you can live with (max 1 year, then rotate), store it server-side only. IP restriction is optional and only useful if the caller has a fixed egress IP. An explicit IBKR statement "the token is read-only" was not found (UNVERIFIED wording), but no write capability is documented.

### 2.2 Sections and fields (verified from IBKR Reporting Guide, accessed 2026-10-15)

Index of all sections: https://guides.interactivebrokers.com/reportingreference/reportguide/activity%20flex%20query%20reference.htm (updated Mar 20, 2025). Per-section field pages are in the same folder (`open positionsfq.htm`, `tradesfq.htm`, ...). Field names below are the labels in the Flex editor. XML attribute names are camel-cased equivalents (e.g. "FIFO Unrealized PNL" -> `fifoPnlUnrealized`) but the attribute spelling is UNVERIFIED because the guide only shows UI labels.

| Section | Fields verified in guide (relevant subset) | Notes / gaps vs the wish list |
|---|---|---|
| Account Information | Account ID, Account Alias, **Currency ("The base currency of your account.")**, Name, Account Type (Individual, Joint, IRA, ...), Account Capabilities (Cash / Portfolio Margin), Date Opened/Funded, IB company (IB-UK, IB-CAN, IB-IN, IB-JP, ...; the Ireland entity value was not in the list I extracted: UNVERIFIED), Dividend Reinvestment Status | Gives base currency and account type. |
| Open Positions | Currency, Asset Class, **FX Rate to Base**, Symbol, Description, Conid, Security ID/Type, CUSIP, **ISIN**, FIGI, Underlying Conid/Symbol, Report Date, **Quantity, Multiplier, Mark Price, Position Value, Open Price, Cost Basis Price, Cost Basis Money, Percent of NAV, FIFO Unrealized PNL**, Side, **Level of Detail ("Summary or Lot")**, Open Date Time, Holding Period Date Time, Originating Order ID (Lot level only), Originating Transaction ID, Accrued Interest | No `listingExchange` and no `subCategory` in this section: get both from "Financial Instrument Information" (Subcategory, Listing Exchange, ISIN, Conid). Mark Price = "The closing price of the position as of the report date" (not live). Values are in instrument currency; multiply by FX Rate to Base for base currency. |
| Trades | Currency, Asset Class, FX Rate to Base, Symbol, Description, Conid, **ListingExchange**, ISIN, **Trade ID**, Report Date, **Trade Date, Trade Time**, Settle Date Target, Transaction Type, **Exchange**, **Quantity, Trade Price**, Multiplier, **Trade Money**, Proceeds, Taxes, **IB Commission, IB Commission Currency**, Close Price, Open/Close Indicator, Notes/Codes, **Cost Basis, Realized PNL**, MTM PNL, **Buy/Sell**, **IB Order ID, IB Execution ID**, Brokerage Order ID and Order Reference ("Available on daily (single-day) activity flex queries only"), Order Time, Open Date Time, Level of Detail, **Net Cash** ("proceeds plus tax plus commissions"), **Order Type**, Trader ID, Is API Order | A combined "Date/Time" is not listed here; the guide splits Trade Date + Trade Time (UNVERIFIED whether the editor also offers a combined one). Levels of Detail offered for the section: "Symbol Summary, Executions, Orders, Asset Class, Closed Lots, Wash Sales". Field "Level of Detail": "Executions, orders or closed lots." Realized PNL: "Realized P/L can be calculated by the proceeds of the closing trade plus commissions and then adding the basis." "For the purpose of cost basis and realized profit or loss, commissions are netted." |
| Cash Transactions | Currency, Asset Class, FX Rate to Base, Symbol, Description, Conid, ISIN, **Date/Time, Amount, Type**, Trade ID, 871(m) Withholding, Code | Section text: "displays cash deposits and withdrawals into and out of your account. The section also shows dividend payments." The guide does **not enumerate the Type values** (Dividends, Withholding Tax, Broker Interest Paid/Received, Other Fees, Deposits/Withdrawals ...). A web-search summary listed Dividends, Withholding Tax, Deposits/Withdrawals, Broker Interest Received, Other Fees from an unnamed tool: UNVERIFIED against IBKR. There is **no `actionID`** field in this section; the guide lists Trade ID and Code. |
| Transfers (ACATS, Internal) | Report Date, Date, Type, **Direction**, Transfer Company/Account/Account Name, Quantity, Transfer Price, Position Amount (+ in Base), P/L Amount (+ in Base), Code, Transaction ID, instrument identifiers | Also see "Incoming/Outgoing Trade Transfers". Cash deposits/withdrawals appear in Cash Transactions. |
| Corporate Actions | Report Date, Date/Time, Amount, Proceeds, Value, Quantity, Realized P/L, MTM PNL, Code, Type, ID, Transaction ID, many code flags | Splits appear here (Type vocabulary not enumerated in the guide: UNVERIFIED). |
| Change in Dividend Accruals | Date, **Ex Date, Pay Date**, Quantity, Tax, Fee, **Gross Rate, Gross Amount, Net Amount**, Code, FromAcct/ToAcct, Report Date | Gross vs net dividends and dates. Also "Open Dividend Accruals". |
| Commission Details | Date/Time, Exchange, Buy/Sell, Quantity, Price, Trade ID, Order Reference, **Total Commission, Broker Execution Charge, Broker Clearing Charge, Third-Party Execution/Clearing/Regulatory Charge, Other** | Breakdown of IB Commission; optional. |
| Realized & Unrealized Performance Summary in Base | per symbol: Realized Short/Long Term Profit/Loss, **Total Realized PNL, Unrealized Profit/Loss (short/long), Total Unrealized PNL, Total FIFO PNL** | Per-symbol totals in base currency, FIFO ("closing transactions are matched to opening transactions"). |
| Net Asset Value (NAV) Summary in Base | Report Date, Cash, Stock, Options, Bonds, Interest Accruals, Dividend Accruals, Total | Report-date snapshot; "Change in NAV" is a separate section. |
| **Currency Conversion Rate** | **Date/Time, From Currency, To Currency, Rate** ("exchange rates versus base currency for the report period") | FX per date for the report period; completeness per day UNVERIFIED. |
| Cash Report | per currency: starting cash, deposits, withdrawals, dividends, broker interest, commissions, other fees, net trades, ... | Reconciliation aid. |
| Financial Instrument Information | Asset Class, Symbol, **Subcategory**, Underlying Category, **Listing Exchange**, Description, Conid, ISIN, FIGI, Multiplier, ... | Source of listingExchange and subCategory. |

Not available anywhere in Flex: live prices, bid/ask, intraday positions.

### 2.3 HTTP flow, errors, polling, limits

Sources (all accessed 2026-10-15): https://www.interactivebrokers.com/docs/web-api/flex-web-service/using-flex-web-service/generate-the-report.md, `.../retrieve-the-report.md`, `.../using-flex-web-service.md`, https://www.interactivebrokers.com/docs/web-api/api-reference/send-request.md, `.../get-statement.md`, https://www.interactivebrokers.com/docs/web-api/flex-web-service/error-codes.md.

1. `GET https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t={token}&q={queryId}&v=3`. Parameters: `v` "Values 2 and 3 are supported; version 3 should always be used"; optional `p` ("A maximum of 365 days may be requested"), or `fd` + `td` (both required together; docs example `20260801`); "Period cannot be used with date range". Default is "the predefined date range within Client Portal".
2. Success: `<FlexStatementResponse ...><Status>Success</Status><ReferenceCode>...</ReferenceCode><url>...</url></FlexStatementResponse>`; "The `<url>` returned in the response body should be ignored." Failure: `<Status>Fail</Status>` with `<ErrorMessage>`.
3. `GET https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?t={token}&q={ReferenceCode}&v=3`. "Depending on the size of the request, you may need to wait longer between the /SendRequest endpoint and /GetStatement endpoint calls." Returned as `Content-Type: text/plain;charset=UTF-8`; format follows the query's configured Format (XML/CSV/text); on failure an XML error response.
4. **User-Agent required**: "Note that all requests must include a User-Agent header." (using-flex-web-service.md; also in the legacy page archived at https://web.archive.org/web/2025/https://www.interactivebrokers.com/campus/ibkr-api-page/flex-web-service/ , accessed 2026-10-15).
5. Rate limit: "1 request per second. A maximum of 10 requests per minute may be submitted" per token (error 1018 text: "Limited to one request per second, 10 requests per minute (per token)"). A separate "1 statement generation per minute" rule is **not documented** (UNVERIFIED).
6. Polling advice (legacy IBKR page, Wayback): "there may be a slight delay between the initial request to generate the report and the report's availability via the second request. Time to availability is also dependent on system utilization, so please permit some flexibility in the timing of the final report retrieval, either via an explicit 'wait' between the first and second requests, or via periodic reattempts of the second request." No numeric interval is given. My recommendation (not IBKR's): wait about 5 s after SendRequest, then retry GetStatement on 1019/1001/1004 every 10-20 s, max about 6 tries, staying inside 10 req/min.

Error codes (verbatim list, error-codes.md): 1001 "Statement could not be generated at this time. Please try again shortly."; 1003 "Statement is not available."; 1004 "Statement is incomplete at this time. Please try again shortly."; 1005 "Settlement data is not ready at this time. Please try again shortly."; 1006 "FIFO P/L data is not ready at this time. Please try again shortly."; 1007 "MTM P/L data is not ready at this time. Please try again shortly."; 1008 "MTM and FIFO P/L data is not ready at this time. Please try again shortly."; 1009 "The server is under heavy load. Statement could not be generated at this time. Please try again shortly."; 1010 "Legacy Flex Queries are no longer supported. Please convert over to Activity Flex."; 1011 "Service account is inactive."; 1012 "Token has expired."; 1013 "IP restriction."; 1014 "Query is invalid."; 1015 "Token is invalid."; 1016 "Account in invalid."; 1017 "Reference code is invalid."; 1018 "Too many requests have been made from this token. Please try again shortly. Limited to one request per second, 10 requests per minute (per token)."; 1019 "Statement generation in progress. Please try again shortly."; 1020 "Invalid request or unable to validate request."; 1021 "Statement could not be retrieved at this time. Please try again shortly."
- Retryable (my classification): 1001, 1004-1009, 1018, 1019, 1021. Fatal, alert the user: 1010-1017, 1020 (1003 "not available": treat as fatal for that date).
- 1006-1008 show P/L data can lag the statement; the clock times when this clears are UNVERIFIED.

**Server use**: nothing in IBKR's docs forbids calling from a server; token + Query ID are the only credentials. XML size for one year of activity: **UNVERIFIED** (no IBKR figure; depends on trade count, lot-level positions and Closed Lots enlarge it).

### 2.4 Periods and data latency

- Period choices in the query's Delivery Configuration: "Last Business Day, Last Business Week, Last Month, Last Quarter, Last 30 Calendar Days, Last 365 Calendar Days, Last N Calendar Days, Month to Date, Quarter to Date or Year to Date." (activityflex.htm). There is **no "Today"** choice. Custom range is available through the Web Service parameters `fd`/`td`, and `p` up to 365 days; whether `fd`/`td` may span more than 365 days is not stated: UNVERIFIED (assume a 365-day cap and chunk requests).
- Latency (IBKR legacy Flex Web Service page, archived 2025, accessed 2026-10-15; the current docs site dropped this paragraph): "'Activity Statement' Flex Queries contain data that is only updated once daily at close of business, so there is no benefit to generating and retrieving these reports more than once per day. Normally one would retrieve the prior day's Activity Statements at the start of the following day, which guarantees that all values have been updated by IB's reporting backend." And: "'Trade Confirmation' Flex Queries will yield updated data throughout the day as executions occur against working orders, but these execution entries are also not available in Trade Confirmation Flex Queries in real-time. Typically a new execution will be available for inclusion in a newly generated Flex Query report within 5 to 10 minutes." And: "the Flex Web Service is not suitable for active polling for newly generated reports."
- So today's intraday trades and positions are not in an Activity Flex Query until the daily build; a Trade Confirmation Flex Query is the only near-intraday source (executions only, no positions). The clock time at which the day's statement becomes available is **not published** (UNVERIFIED): schedule the job for the next morning (Europe) and handle 1006-1008/1019 retries.

### 2.5 Coverage table: what each analytics figure can be computed from

| Analytics figure | Computable from Flex? | From which section/fields | Currency / caveats |
|---|---|---|---|
| Per-position cost basis | Yes | Open Positions: Cost Basis Price / Cost Basis Money (Level of Detail = Lot for lots) | Instrument currency; convert with FX Rate to Base. Cost Basis Price = "The average price of the position". |
| Unrealized P/L | Yes, as of report date close | Open Positions: FIFO Unrealized PNL; Realized & Unrealized Performance Summary in Base | Open Positions is in instrument currency (inferred: UNVERIFIED); the Summary is in base. Mark price is the report-date close, not live. For live unrealized P/L combine Quantity and Cost Basis with external live quotes. |
| Realized P/L per closed lot incl. partial sales | Yes | Trades with Level of Detail = Closed Lots (plus Executions): Realized PNL, Cost Basis, Open Date Time | FIFO matching is IBKR's. Requires selecting "Closed Lots" in the Trades section. |
| Dividends net of withholding by security | Yes | Cash Transactions: Type, Amount, Currency, Symbol/ISIN/Conid, Date/Time; Change in Dividend Accruals: Gross Amount, Tax, Net Amount, Ex/Pay Date | Pair Dividends with Withholding Tax rows by Conid/date; Type labels not enumerated in the guide (UNVERIFIED). Amounts in cash currency. |
| Commissions | Yes | Trades: IB Commission + IB Commission Currency; Commission Details for breakdown | Commission currency can differ from the trade currency. |
| FX per day for a consistent reporting currency | Yes | Currency Conversion Rate: Date/Time, From, To, Rate; also FX Rate to Base on each row | Select the section for the analysed period; base currency from Account Information. |
| Transfers in/out | Yes | Transfers (ACATS, Internal); Cash Transactions deposits/withdrawals | |
| Splits / corporate actions | Yes | Corporate Actions (Quantity, Proceeds, Value, Realized P/L, Type, Code) | Mapping of Type to split vs merger needs sample data (vocabulary UNVERIFIED). |
| NAV history | Partly | NAV Summary in Base (per report date), Change in NAV | One row per statement. |
| Live prices, intraday P/L | **No** | - | Use another quote source. |

### 2.6 Paper-trading account

Not documented in anything I read. A search summary of third-party MCP-server docs implied Flex tokens can be used with a paper configuration but does not say how. **UNVERIFIED.** Test: log into Client Portal with the paper username and look for Reporting -> Flex Queries -> Flex Web Service Configuration. If absent, develop against the live account's Flex output or saved sample XML.

---

## 3. Deep links into IBKR for a specific stock

All probes: `curl -sL -A "Mozilla/5.0 ..."`, accessed 2026-10-15, not logged in. "Verified" means HTTP result and title only, **not** that the instrument opens.

| URL pattern | HTTP result | Title / behaviour | Login | Verdict |
|---|---|---|---|---|
| `https://www.interactivebrokers.com/sso/Login` | 200, redirected to `https://www.interactivebrokers.ie/sso/Login` (entity domain chosen by my IP) | "Login" | Yes (is the login) | Safe general link. |
| `https://www.interactivebrokers.com/sso/Login?action=ACCT_MGMT_MAIN&RL=1` | 200, redirected to `.ie` with query kept | "Login" | Yes | What `action` does after login is undocumented (UNVERIFIED). |
| `https://www.interactivebrokers.com/portal` | 200, redirected to `https://ndcdyn.interactivebrokers.com/portal/` | "Client Portal" (SPA shell; loads `/lib/ibot/widget.js`, i.e. iBot is embedded) | Yes (SPA asks for login) | Safe general link. |
| `https://www.interactivebrokers.com/portal/#/quote/272093` | 200, same shell | "Client Portal" | Yes | Fragment is client-side only; cannot be verified without logging in. UNVERIFIED. |
| `https://portal.interactivebrokers.com/portal/?action=QUOTE&conid=272093` | 200, no redirect, same shell (sets a `portal` cookie) | "Client Portal" | Yes | Shell returned for any query; no evidence `action`/`conid` is honoured. UNVERIFIED. |
| `https://www.interactivebrokers.com/webtrader` | 404 | "404 Page Not Found" | - | Dead. |
| `https://contract.ibkr.info/v3.10/index.php?action=Details&site=GEN&conid=272093` and `https://misc.interactivebrokers.com/cstools/contract_info/v3.10/index.php?action=Details&site=GEN&conid=12178239` | 200 after redirect to `https://www.interactivebrokers.com/en/trading/products-exchanges.php#/` | "Products, Exchanges and Contracts Search" (legacy Contract Information Center folded into the new SPA) | No | Does **not** open the contract directly any more. |
| `https://www.interactivebrokers.com/en/index.php?f=2222&exch=ibis&showcategories=STK` (also `exch=aeb`, `?f=1562`) | 200 after redirect to `/en/trading/products-exchanges.php` | Same title; the parameters are dropped | No | Legacy params no longer select an exchange; page is an SPA (section 4). |

Documentation search: I looked for IBKR KB/Campus/Reporting-Guide articles about launching Client Portal with a symbol, URL parameters or deep links and found **none**. Plain statement: **no documented deep link for a specific instrument exists.**

Recommendation: link to `https://www.interactivebrokers.com/sso/Login` (or `/portal`) and show a "Trade this" card with: company, IBKR local symbol, exchange code (IBIS then AEB), conid, ISIN, currency, and the iBot prompt with a copy button. Optionally let the owner test `https://portal.interactivebrokers.com/portal/?action=QUOTE&conid={conid}` once while logged in; if it works, add it as a feature-flagged enhancement.

---

## 4. Public contract/conid lookup (no login) and scraping permission

**Finding:** https://www.interactivebrokers.com/en/trading/products-exchanges.php (title "Products, Exchanges and Contracts Search") is a webpack SPA (`/products.exchanges.search/index.js`). Its bundle calls these same-origin endpoints (read from the bundle, accessed 2026-10-15):

| Endpoint | Method | Verified call |
|---|---|---|
| `/webrest/exchanges/` | GET | 200 JSON `{"exchanges":[{"id","name","country","region","assets","country_code"}...]}` (34 KB); no cookies. |
| `/webrest/search/products-by-exchangeId` | POST JSON | Works: body `{"domain":"com","exchangeId":"IBIS","pageNumber":1,"pageSize":100,"sortDirection":"asc","sortField":"symbol"}` returns `{"products":[...],"productTypeCount":[...],"productCount":N}`. Needs `Content-Type: application/json`; I also sent a `Referer` of the products page. `pageSize` 2000 and the `-productType` variant returned HTTP 500 with my payload; use pageSize 100 and paginate. |
| `/webrest/search/products-by-filters` | POST JSON | Works: body `{"domain":"com","newProduct":"all","pageNumber":1,"pageSize":20,"productCountry":[],"productSymbol":"MSF","productType":["STK"],"sortDirection":"asc","sortField":"symbol"}`; `productSymbol` matches symbol or description text ("MICROSOFT" returned MSFT/TXSE; "MSF" returned the CHIXDE listing). A `productCountry` of DE/NL returned nothing for these queries (semantics unclear). The result shows one row per product (one venue), not every venue. |
| `/webrest/search/product-types/summary`, `/webrest/exchanges/search/`, `/webrest/orderTypes/{id}?exchangeId={id}` | POST/GET | Seen in the bundle; `orderTypes/IBIS` returned JSON (natives/simulated order type lists). |
| `/portal.proxy/v1/mkt/iserver/secdef/search` | POST | Seen in the bundle (for signed-in users; not tested). |

Product row structure (verified): `{"type":"STK","symbol":"MSF","exchangeId":"IBIS","localSymbol":"MSF","description":"MICROSOFT CORP","conid":12178239,"isin":"US5949181045","cusip":"594918104","currency":"EUR","country":"DE","isPrimeExchId":"T",...}`.

Facts established with it:
- IBIS listing: 2249 products (1267 STK, 973 ETF, 9 IND); AEB listing: 1064 products (STK, ETF, IOPT, IND). I paginated both fully (about 35 calls, 0.3 s apart).
- "Microsoft on Xetra" = `MSF`, conid **12178239**, EUR. The same conid appears for the CHIXDE listing (`localSymbol` "MSFd"), so **conid is per product+currency, not per venue**; the venue is selected through the exchange/destination field (consistent with the Web API statement in `ibkr-feasibility.md`).
- Descriptions can be stale (Alphabet class C `ABEC` is labelled "GOOGLE INC."): match on ISIN, not on description.
- `localSymbol` can differ from `symbol` on AEB (Unilever PLC: symbol `UNVB`, localSymbol `UNA`; ETFs/ETPs often differ). For ordering, use `localSymbol`.

**Scraping/permission:** `https://www.interactivebrokers.com/robots.txt` (accessed 2026-10-15) contains only `Disallow: /smf/`, `/fluxbb/`, `/insights/ibtr_alerts.php`, `/search/`, `/referral/` (plus Algolia verification comments and a sitemap line); `/webrest/` and `/en/trading/products-exchanges.php` are not disallowed. IBKR's website terms of use: I could not locate the page (guessed legal URLs return 404; a web search found nothing), so whether automated use of `/webrest/*` is allowed is **UNVERIFIED**. The endpoints are undocumented and may change or be rate-limited without notice. Recommendation: use them for an occasional (e.g. weekly) catalogue import of IBIS and AEB into the app's own table keyed by ISIN, not per-user live calls; keep manual entry of the local symbol as a fallback; ask IBKR support if heavier use is planned. The authenticated alternative is the Web API `GET /iserver/secdef/search` (needs a gateway session, see `ibkr-feasibility.md`).

---

## 5. iBot grammar and exchange codes

### 5.1 What iBot is (verified)

- Product page: "IBot lets you trade, research markets, and manage your account using natural language. Instead of navigating menus or searching for tools, simply type what you want to do. IBot interprets your request and prepares the action instantly." ... "Use IBot within Trader Workstation (TWS), Client Portal, and IBKR Mobile". Source: https://www.interactivebrokers.com/en/trading/ibot.php (accessed 2026-10-15, curl).
- Order examples on that page (verbatim): "Trade 200 shares of IBKR", "Buy SPY calls at the ask", "Close all positions". "IBot prepares the order ticket for review before submission so you maintain full control." and "You can: Modify all order parameters / Refresh market data before submission / Confirm every action manually."
- TWS guide (https://www.ibkrguides.com/traderworkstation/ibot.htm, accessed 2026-10-15): "IBot's text entry field accepts commands you enter in plain English"; Orders: "buy 100 shares of Apple at market", "sell 100 shares of AAPL at 40", "close my Apple position", "close 10% of my long positions"; "You MUST click the Submit button located within IBot to place the order"; Modify: "change this order to market"; Help: "help with orders"; iBot can "create and submit orders (including complex algos!)".
- Mobile guide (https://www.ibkrguides.com/iphone/ibot.htm, accessed 2026-10-15): "IBot is a natural-language interface that understands commands in plain English." Example "trade 200 shares ibkr."; "If there are two different contracts that match your request, please select the desired one."; "Verify that IBot's response is accurate and reflects your request, and modify parameters as needed."; buttons "1=Refresh Market Data, 2=Submit Order, 3=Cancel". It states iBot is "powered by Large Language Models (LLMs)" and responses are provided "as is".
- Limit orders: the verified example is "sell 100 shares of AAPL at 40" (price after "at"); a "buy this at 176" example appeared only in a search-engine summary (UNVERIFIED).

### 5.2 Does the owner's phrasing match documented grammar?

Prompt used: "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2".
- Structure (verb + quantity + symbol + "at price") is within the documented style. iBot is LLM-based and free-form, so "Create buy limit order ..." is plausible: inferred, not documented.
- **Destination/routing words:** none of the IBKR pages above mention specifying a destination or exchange inside the sentence. Whether iBot parses "set destination IBIS2" is **UNVERIFIED** (the owner reports using it; that is not an IBKR source). The documented path is: iBot builds the ticket, then you "modify all order parameters" on the ticket.
- Contract ambiguity: "MSF" may match more than one contract; iBot asks to choose ("select the desired one"). The app should show the expected identifiers and tell the owner to verify the ticket shows conid 12178239 / EUR / the intended venue.
- Safest generated prompt: `Buy 10 shares of MSF at 400 limit`, plus an instruction line "On the ticket set destination to IBIS (fallback AEB for Dutch listings)". Offer the owner's long form as an optional second variant.

Preview/confirm: ticket shown first; nothing is sent until Submit is pressed (TWS guide); mobile offers Refresh Market Data / Submit Order / Cancel.

### 5.3 Exchange/destination codes (IBKR public catalogue `/webrest/exchanges/`, accessed 2026-10-15)

| Code | IBKR name in catalogue | Country | Assets | Status |
|---|---|---|---|---|
| IBIS | "Integriertes Boersenhandels- und Informations-System" | Germany | Indices, Stocks | Verified. Xetra: IBKR fee page "Xetra (IBIS) Fees": https://www.interactivebrokers.com/en/accounts/fees/IBIS-StkFees.php |
| IBIS2 | **not in catalogue** | - | - | UNVERIFIED. Only third parties: eupersonalfinance.eu ("IBIS is Xetra's main equity board; IBIS2 is the ETF-specific segment on Xetra"), matchmybroker.com ("Both codes point to Deutsche Boerse's Xetra"), bankeronwheels.com ("XETRA (denoted as IBIS2)"). These are not IBKR documents and partly disagree. No introduction date found; no IBKR statement that it is a "T7" destination. Hypothesis (unverified): IBIS2 is a second Xetra board used for ETFs. Evidence supporting it: the public IBIS list contains the stocks MSF, APC, ABEA, AMZ, NVD, TL0, SAP, SIE. A lookup of EUNL/IWDA/VWCE ETFs did not show IBIS rows in the public listing (the list shows one venue per product, so inconclusive). |
| AEB | "Amsterdamse Effectenbeurs" | Netherlands | Indices, Stocks, Structured Products | Verified. |
| FWB | "Frankfurter Wertpapierboerse" | Germany | Stocks, Structured Products, Warrants | Verified. `FWB2` not in catalogue. |
| SWB | "Stuttgart Wertpapierboerse" | Germany | Stocks, Structured Products, Warrants | Verified. `SWB2` not in catalogue. |
| GETTEX | "Boerse Muenchen AG" (name garbled by encoding in my output) | Germany | Stocks, Structured Products, Warrants | Verified. |
| TGATE | "TradeGate" | Germany | Stocks | Verified. |
| LSE | "London Stock Exchange" | United Kingdom | Indices, Stocks | Verified. |
| SBF | "Society des Bourses Francaises" | France | Indices, Stocks, Structured Products, Warrants | Verified (Euronext Paris). |
| BVME | "Borsa Valori di Milano" | Italy | Indices, Stocks, Warrants | Verified. |
| EBS | "Elektronische Boerse Schweiz" | Switzerland | Bonds, Indices, Stocks, ... | Verified (SIX). |
| SMART | not an exchange in the catalogue | - | - | Routing mode; primary-source confirmation not obtained in this run (UNVERIFIED here). |

Other German multilateral venues are separate codes (`CHIXDE`, `BATEDE`, `TRQXDE`, `DXEDE`, `TGHEDE`), which is why one conid shows up on several venues.

---

## 6. Xetra / AEB local symbol mapping vs Yahoo (verified 2026-10-15)

IBKR side: public product list (`/webrest/search/products-by-exchangeId`, IBIS and AEB fully paginated). Yahoo side: `curl -sL -A "Mozilla/5.0 ..." https://finance.yahoo.com/quote/{TICKER}/`; the `<title>` names the company, and a non-existent ticker (`ZZQX9.DE`) returned the "Symbol Lookup from Yahoo Finance" page, so the title is a real existence check. In the HTML for `MSF.DE` the exchange string is "XETRA - Delayed Quote", for `ASML.AS` "Amsterdam - Delayed Quote". Yahoo's currency was not parsed (UNVERIFIED); IBKR says EUR for all rows.

| Company | IBKR exchange | IBKR symbol / localSymbol | conid | ISIN | Currency | Yahoo ticker | Yahoo page title |
|---|---|---|---|---|---|---|---|
| Microsoft | IBIS | MSF / MSF | 12178239 | US5949181045 | EUR | MSF.DE | Microsoft Corporation (MSF.DE) |
| Apple | IBIS | APC / APC | 13013300 | US0378331005 | EUR | APC.DE | Apple Inc. (APC.DE) |
| Alphabet class A | IBIS | ABEA / ABEA | 208710587 | US02079K3059 | EUR | ABEA.DE | Alphabet Inc. (ABEA.DE) |
| Alphabet class C | IBIS | ABEC / ABEC (stale description "GOOGLE INC.") | 208914695 | US02079K1079 | EUR | ABEC.DE | Alphabet Inc. (ABEC.DE) |
| Amazon | IBIS | AMZ / AMZ | 13013290 | US0231351067 | EUR | AMZ.DE | Amazon.com, Inc. (AMZ.DE) |
| NVIDIA | IBIS | NVD / NVD | 13104788 | US67066G1040 | EUR | NVD.DE | NVIDIA Corporation (NVD.DE) |
| Tesla | IBIS | TL0 / TL0 | 78046366 | US88160R1014 | EUR | TL0.DE | Tesla, Inc. (TL0.DE) |
| SAP | IBIS | SAP / SAP | 14204 | DE0007164600 | EUR | SAP.DE | SAP SE (SAP.DE) |
| Siemens | IBIS | SIE / SIE | 14217 | DE0007236101 | EUR | SIE.DE | Siemens Aktiengesellschaft (SIE.DE) |
| ASML | AEB | ASML / ASML | 117589399 | NL0010273215 | EUR | ASML.AS | ASML Holding N.V. (ASML.AS) |
| Adyen | AEB | ADYEN / ADYEN | 321202935 | NL0012969182 | EUR | ADYEN.AS | Adyen N.V. (ADYEN.AS) |
| ING Groep | AEB | INGA / INGA | 240601748 | NL0011821202 | EUR | INGA.AS | ING Groep N.V. (INGA.AS) |
| Heineken | AEB | HEIA / HEIA | 29622888 | NL0000009165 | EUR | HEIA.AS | Heineken N.V. (HEIA.AS) |
| Philips | AEB | PHIA / PHIA | 29622921 | NL0000009538 | EUR | PHIA.AS | Koninklijke Philips N.V. (PHIA.AS) |
| Prosus | AEB | PRX / PRX | 382625193 | NL0013654783 | EUR | PRX.AS | Prosus N.V. (PRX.AS) |
| Shell plc | AEB | SHELL / SHELL | 541411967 | GB00BP6MXD84 | EUR | SHELL.AS | Shell plc (SHELL.AS) |
| Unilever PLC | AEB | UNVB / **UNA** | 837455595 | GB00BVZK7T90 | EUR | not tested | symbol and localSymbol differ: use localSymbol (UNA) for orders; Yahoo ticker UNVERIFIED |

Conclusion: for the 15 tested pairs the IBKR symbol equals the Yahoo base ticker (`{symbol}.DE` for IBIS, `{symbol}.AS` for AEB). Equivalence is **not guaranteed** (Unilever differs; AEB ETFs/ETPs often differ; several US stocks on IBIS use WKN-like codes such as `TL0`, `NVD`, `APC`). Match by ISIN, keep IBKR `localSymbol` as the order symbol, and store the Yahoo ticker as a separate field.

---

## 7. Open questions / unverified

1. Whether Client Portal honours any URL parameters to open an instrument (test while logged in; none documented).
2. Whether iBot parses "set destination XXXX" inside the sentence; what IBIS2 is (no IBKR primary source); when it appeared; whether it applies to stocks, ETFs or both.
3. IBKR website terms on automated use of `/webrest/*`; the endpoints are undocumented and may change.
4. Flex: XML size for 365 days; exact time the daily statement becomes available; whether `fd`/`td` may exceed 365 days; Cash Transactions Type and Corporate Actions Type vocabularies; XML attribute spellings (UI labels verified, attribute names inferred); paper-account Flex availability and how to enable it; whether FIFO Unrealized PNL in Open Positions is in instrument currency; a "1 statement generation per minute" rule (not documented); an explicit "read-only token" statement.
5. Yahoo currency per mapped ticker (not parsed); Yahoo ticker for Unilever not tested.
6. `SMART` code: not verified in a primary source in this run.

---

## 8. Sources (all accessed 2026-10-15)

IBKR primary:
- https://www.interactivebrokers.com/docs/web-api/flex-web-service/introduction.md
- https://www.interactivebrokers.com/docs/web-api/flex-web-service/client-portal-configuration/enable-and-create-access-token.md
- https://www.interactivebrokers.com/docs/web-api/flex-web-service/client-portal-configuration/create-a-flex-query.md
- https://www.interactivebrokers.com/docs/web-api/flex-web-service/using-flex-web-service.md
- https://www.interactivebrokers.com/docs/web-api/flex-web-service/using-flex-web-service/generate-the-report.md
- https://www.interactivebrokers.com/docs/web-api/flex-web-service/using-flex-web-service/retrieve-the-report.md
- https://www.interactivebrokers.com/docs/web-api/flex-web-service/error-codes.md
- https://www.interactivebrokers.com/docs/web-api/api-reference/send-request.md and `.../get-statement.md`
- https://web.archive.org/web/2025/https://www.interactivebrokers.com/campus/ibkr-api-page/flex-web-service/ (archived legacy Campus page: latency, polling, User-Agent)
- https://www.ibkrguides.com/clientportal/performanceandstatements/flex.htm
- https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm
- https://guides.interactivebrokers.com/reportingreference/reportguide/activity%20flex%20query%20reference.htm and sub-pages in the same folder: `open positionsfq.htm`, `tradesfq.htm`, `cash transactionsfq.htm`, `currency conversion ratefq.htm`, `account information activity flex.htm`, `net asset value (nav) summary in base.htm`, `realized and unrealized performance summary in basefq.htm`, `change in dividend accrualsfq.htm`, `transfersfq.htm`, `corporate actionsfq.htm`, `commission detailsfq.htm`, `financialinstrumentinformationfq.htm`, `cash reportfq.htm`
- https://www.interactivebrokers.com/en/trading/ibot.php
- https://www.ibkrguides.com/traderworkstation/ibot.htm
- https://www.ibkrguides.com/iphone/ibot.htm
- https://www.interactivebrokers.com/en/trading/products-exchanges.php (SPA), its bundle https://www.interactivebrokers.com/products.exchanges.search/index.js, and endpoints under https://www.interactivebrokers.com/webrest/ (exchanges/, search/products-by-exchangeId, search/products-by-filters, orderTypes/IBIS)
- https://www.interactivebrokers.com/robots.txt
- https://www.interactivebrokers.com/sso/Login ; https://www.interactivebrokers.com/portal ; https://ndcdyn.interactivebrokers.com/portal/ ; https://portal.interactivebrokers.com/portal/?action=QUOTE&conid=272093
- https://www.interactivebrokers.com/en/accounts/fees/IBIS-StkFees.php (IBIS code; cited in the earlier report, title also seen in a search listing)

Yahoo (existence checks): https://finance.yahoo.com/quote/{MSF.DE, APC.DE, ABEA.DE, ABEC.DE, AMZ.DE, NVD.DE, TL0.DE, SAP.DE, SIE.DE, ASML.AS, ADYEN.AS, INGA.AS, HEIA.AS, PHIA.AS, PRX.AS, SHELL.AS}/ and negative control `ZZQX9.DE`.

Third party, low reliability (IBIS2 only):
- https://www.eupersonalfinance.eu/articles/ibkr-exchange-codes-europe
- https://www.matchmybroker.com/articles/stock-exchange-codes-on-interactive-brokers
- https://www.bankeronwheels.com/interactive-brokers-stock-exchanges-codes/
