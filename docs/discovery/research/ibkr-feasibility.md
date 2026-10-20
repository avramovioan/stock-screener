# IBKR API Feasibility for a Hosted Personal Web App (Supabase Edge Functions)

Research date: 2026-10-15. Researcher notes for the report writer. No code written.

Method note: the IBKR documentation sites returned HTTP 403 to the WebFetch tool. The same official pages were retrieved with `curl` and a browser User-Agent, using IBKR's own `.md` page variants (documented in `https://www.interactivebrokers.com/docs/web-api/llms.txt`). All "official" quotes below were read directly from those pages on 2026-10-15. The docs print no version number. The Web API changelog's newest entry is dated Oct 10, 2026, so the docs are current to about that date. Items I could not read from a primary source are marked UNVERIFIED.

---

## 1. Executive feasibility conclusion

**Verdict: Partial. Live trading from Supabase Edge Functions is not officially supported for an individual account, and the one technical route that would work is unsupported.**

IBKR's current documentation says individual ("retail") clients authenticate to the Web API with the Client Portal Gateway (CPGW). The Gateway is a local Java process and cannot run inside a serverless function. IBKR also says it "does not support an automated authentication process for Client Portal Gateway" and that "Clients must reauthenticate using the Client Portal Gateway at daily". Its limitations page requires the browser login and every API call to happen "on the same machine where the Client Portal Gateway was authenticated". OAuth 2.0 is explicitly "not available to Individual account structures". OAuth 1.0a (the only fully headless route) is documented for advisors, institutions and approved third-party vendors, and IBKR's first-party registration page "classifies first party entities as institutions".

The gap between documentation and reality is OAuth 1.0a. Community sources report the OAuth 1.0a self-service portal works for individual Pro accounts (live and paper). They also quote an IBKR API support agent: "I'm not aware of any technical limitations which would prevent an individual accountholder from accessing the OAuth 1.0a self-service portal". I could not verify this against an IBKR primary source. The portal terms are behind a login, and a Reddit summary says the terms state individual accounts are not eligible. If it works, a cron tick can keep the brokerage session alive with no human login and no stored username/password. The cost is a set of long-lived secrets (RSA private keys, access token secret, DH prime) and an unsupported path IBKR could close at any time.

**Recommendation:** do not make the core trading path depend on an unsupported OAuth path. Use Option C (Flex Web Service) for analytics and history. For live order entry, use Option B (user-run Gateway plus local bridge) as the supported route. Treat Option A as an optional spike that needs written confirmation from IBKR API Support first. Hard blocker for the brief as written: a headless, no-human, no-stored-password, always-on trading session for an individual account has no officially supported path. The brief must also avoid "perpetual connectivity" claims, because every path needs a daily re-authentication or re-handshake and brokerage sessions drop after about 5 minutes idle.

---

## 2. Authentication comparison

| Dimension | Client Portal Gateway (CPGW) | OAuth 1.0a (first-party) | OAuth 2.0 (private_key_jwt) |
|---|---|---|---|
| Available to individuals | **Yes, documented.** "For retail and individual clients, Authentication to our WebAPI is managed using the Client Portal Gateway." Needs a fully open, funded IBKR Pro account. | **Officially no.** Listed for advisors, brokers, prop groups, hedge funds, institutional investors, third-party developers. Registration page says first party entities are "institutions"; approval by email to apiintegration@. **Unofficially reported to work** for individuals (community, UNVERIFIED). | **No.** "OAuth 2.0 is not available to Individual account structures." Also labelled "(beta)". |
| User interaction | Browser login on the same machine, with 2FA, every day. IBKR does not support automating it. | None after setup. One-time self-service portal setup (consumer key, RSA keys, DH params, token generation). | None after registration. Registration is via IBKR API Solutions, not self-service. |
| Session lifetime | Authenticated session "up to 24 hours", reset around midnight (NY / Zug / HK by nearest connection). Brokerage session ends after 5 min idle ("approximately 6 minutes" in the FAQ). Call `/tickle` about every 60 s. | Live Session Token (LST) valid for a "24 hour period". Access token and secret kept "until access is manually revoked". Brokerage session after `/iserver/auth/ssodh/init` still times out after 5 min idle. | Bearer assertion `exp` is 24 h. Same 5 min brokerage idle timeout. Websockets use `sessionToken` query parameter (changelog Mar 12, 2026). |
| Serverless feasibility | **Blocked.** Local Java process on localhost:5000, same-machine requirement. | **Feasible in principle.** Plain HTTPS to `https://api.ibkr.com`. Needs RSA-SHA256 signing, a Diffie-Hellman exchange, HMAC-SHA256 request signing. Deno can do big-integer maths. Inference: WebCrypto has no RSAES-PKCS1-v1_5 decrypt, so a JS crypto library is probably needed to decrypt the access token secret. | Feasible in principle, not available to the user. |
| Trading allowed | Yes. | Yes (docs: OAuth 1.0a "Offers access to trading features only"). | Yes, plus account management for institutional types. |
| Setup steps | Create and fund IBKR Pro account. Install Java. Download and unzip gateway. `bin\run.bat root\conf.yaml`. Open `https://localhost:5000` and log in (paper: use the paper username). | Self-service portal (ibind docs): generate RSA signing and encryption keys and DH params, choose a 9-character consumer key, upload the three public items, generate access token and secret, toggle "Enable OAuth Access". | Email api-solutions@. RSA public key (>= 3072 bit) via secure message center from a live-account user. |
| Blockers | No automation. Daily login with 2FA (IB Key, Handy Key, SMS, DSC+ supported; Security Code Card unsupported). Cannot sit behind a hosted service. | Unsupported for individuals. Possible ToS exposure. Activation delay. A concurrent TWS/mobile login still displaces the session. | Not available. |

Other facts:

- **Activation delay (OAuth 1.0a).** IBKR: "Registering a Consumer Key via the Self-Service Portal will not be valid until after Midnight in New York ... Attempting to use the new Consumer Key prior to the reset will result in an error (you may receive a 401 Invalid Consumer error)." Community reports range from 24 hours to two weeks (ibind docs).
- **Competing sessions.** "A single username can only have one brokerage session active at a time across all IB platforms." Logging into TWS, Client Portal or IBKR Mobile displaces the API brokerage session. IBKR's workaround: a second username for the API; "any username subscribed will be assessed a separate market data subscription fee". `POST /iserver/auth/ssodh/init` takes `publish` (always true) and `compete` (true disconnects other sessions).
- **Read-only tier.** Non-`/iserver` endpoints (portfolio data, some search) work without a brokerage session and leave an existing brokerage session "undisturbed".
- **Post-init steps.** After `/ssodh/init`, wait 2 seconds, call `GET /iserver/accounts`, confirm a non-empty response.
- **Third-party route.** Vendors "may currently only seek approval for the use of OAuth1.0a", need an established business entity and compliance approval (stated estimates: 2-3 weeks screening, 3-6 weeks compliance, 3-5 weeks legal and configuration). It is built for vendors serving other IBKR clients, not for one person's own app.
- **Client agreement and self-hosted apps.** No primary-source clause found. CPGW for individuals is clearly intended for one's own account. For OAuth, the portal terms are behind login: UNVERIFIED.
- **Entity differences (IBKR Ireland vs LLC).** No Ireland-specific Web API restriction found in the docs I read. The only entity-specific restriction found concerns Canadian residents trading Canadian products. UNVERIFIED whether Ireland-entity accounts differ for OAuth self-service eligibility. Account JSON includes `ibEntity` (example `IBLLC-US`). ibind notes IBKR told some users to use the US domain for OAuth setup.

---

## 3. Capability matrix

Legend: Feasible / Partial / Blocked. "CPGW" means a local machine with daily human login. "OAuth" means the unsupported-for-individuals OAuth 1.0a path called from Edge Functions.

| # | Capability | Rating | Endpoint(s) and constraints |
|---|---|---|---|
| 1 | Authorized account identity | Feasible | `GET /portfolio/accounts` (call before other `/portfolio` endpoints; 1 req/5 s), `GET /iserver/accounts` (tradable accounts), `GET /sso/validate` (CPGW and OAuth 2.0 only; 1 req/min). Response includes `accountId`, `type`, `ibEntity`, `brokerageAccess`. |
| 2 | Open positions | Feasible | `GET /portfolio/{acct}/positions/{page}` (read-only tier, no brokerage session needed). Paged. |
| 3 | Current account values | Feasible | `GET /portfolio/{acct}/ledger` (per currency: `cashbalance`, `netliquidationvalue`, `stockmarketvalue`, `unrealizedpnl`, `realizedpnl`, `dividends`) and `GET /portfolio/{acct}/summary`. |
| 4 | Current or delayed quotes, refreshed every few seconds | Partial | `GET /iserver/marketdata/snapshot?conids=..&fields=31,84,86,7059,6509`. Needs a brokerage session. First call per conid is a pre-flight that "will not deliver any data"; call again. 10 req/s. Max 100 conids and 50 fields per call; 100 market data lines by default. `/iserver/marketdata/unsubscribe` and `unsubscribeall` free lines. Delayed data is free by default per an IBKR Campus search summary (6509 first char `D`; not read in full). CPGW: polling only while the user's machine and session are alive. OAuth: 3-5 s polling is within limits. WebSocket `smd+conid+{...}` cannot run from Edge Functions, and SMD streams terminate after 10 minutes (changelog Apr 14, 2026). |
| 5 | Contract discovery | Partial | `GET /iserver/secdef/search?symbol=..` (`name=true` for company name), `GET /trsrv/stocks?symbols=..` (returns `contracts` with `conid`, `exchange`, `isUS`), `GET /iserver/contract/{conid}/info-and-rules`. Search by ISIN is not documented in anything I read: UNVERIFIED. `secType` parameter removed from `/iserver/secdef/search` (changelog Sep 9, 2026). |
| 6 | Exchange / destination identification (IBIS, then AEB; directed vs SMART) | Partial | `info-and-rules` returns `valid_exchanges` (comma separated), `currency`, `local_symbol`, `is_zero_commission_security`. Order body accepts `conidex` (IBKR example `"265598@SMART"`) and `listingExchange`. Directed routing as `conid@IBIS` is an inference from the SMART example: UNVERIFIED. Orders and trades return `listingExchange` / `exchange`. Needs a paper-account test per instrument. |
| 7 | Estimated commissions | Feasible | `POST /iserver/account/{acct}/orders/whatif`. IBKR: "Clients must query /iserver/marketdata/snapshot for the instrument prior to requesting the /whatif endpoint." Response: `amount.commission` (formatted string, example "1 USD"), `amount.total`, `equity`, `initial`, `maintenance`, `position`, `warn`, `error`. Parse strings defensively. "/whatif orders are also effected by our message suppression endpoint". |
| 8 | Limit-order placement | Feasible | `POST /iserver/account/{acct}/orders` with `conid`, `orderType: "LMT"`, `side`, `quantity`, `price`, `tif`; optional `cOID` (returned as `order_ref`), `listingExchange`, `conidex`. May return reply prompts confirmed via `POST /iserver/reply/{replyId}` with `{"confirmed": true}`. IBKR: "Developers should not attempt to place another order until the previous order has been fully acknowledged". Suppression via `POST /iserver/questions/suppress` lasts only for the brokerage session, so resend after each re-init. Server-side `cOID` uniqueness: UNVERIFIED; treat as a reference, not a hard idempotency key. |
| 9 | Order modify / cancel | Feasible | Modify: `POST /iserver/account/{acct}/order/{orderId}` with the full original body and changed fields (single object, not an array). Cancel: `DELETE /iserver/account/{acct}/order/{orderId}`; "Request was submitted" means received, not cancelled. |
| 10 | Execution / partial-fill info | Partial | `GET /iserver/account/orders?filters=..&force=true&accountId=..` (1 req/5 s; "cancelled or filled within the same brokerage session"; fields `status`, `filledQuantity`, `remainingQuantity`, `avgPrice`, `order_ref`), `GET /iserver/account/order/status/{orderId}`, `GET /iserver/account/trades?days=N` ("current day and six previous days", "advised to call this endpoint once per session", 1 req/5 s; fields `execution_id`, `size`, `price`, `commission`, `exchange`, `listing_exchange`, `trade_time_r`, `order_ref`). Streaming order events (`sor` websocket topic) are unusable from Edge Functions, so everything is polled. Status vocabulary: Inactive, PendingSubmit, PreSubmitted, Submitted, Filled, PendingCancel, PreCancelled, Cancelled, WarnState. |
| 11 | Session recovery and reconciliation | Partial (OAuth); Blocked headless (CPGW) | After a drop, re-run `/ssodh/init` then reconcile from `/iserver/account/orders` (this session only) and `/iserver/account/trades` (7 days); confirm against Flex later. CPGW recovery after the daily reset needs a human browser login. Reset time conflict: Trading docs say `/iserver` is unavailable about 01:00 CEST; v1 maintenance page says 00:00 CEST. |
| + | Trade / dividend / cash history, realized P&L | Feasible via Flex only | Flex Web Service (section 4C). `/pa/transactions` is limited to 1 req/15 min; dividend coverage not verified. |
| + | Paper trading | Feasible with caveats | Use the paper username with CPGW. OAuth registration on paper reported possible by logging into the portal with the paper user (community only). The live account must be "fully open and funded" and IBKR Pro even for paper use. Paper market data entitlements and delayed-only behaviour: UNVERIFIED. |

### Market data availability code (field 6509), verbatim

"First character defines market data timeline. This includes: R = RealTime, D = Delayed, Z = Frozen, Y = Frozen Delayed, N = Not Subscribed. Second character defines the data structure. This includes: P = Snapshot, p = Consolidated. Third character defines the type of data: This will always return: B = Book." Also `O` = "The annual Market Data API Acknowledgement has not been completed for the given user". The fields page also lists `i` (incomplete) and `v` (VDR exempt). IBKR example value: `"6509": "RpB"`. D = "15-20 min delayed". Z and Y mean the last recorded data at close.

Subscription requirement, verbatim: "In order to retrieve top-of-book, depth-of-book, or historical market data from the Web API, the following must be available: Username with relevant live market data subscriptions and permission to trade the desired instruments". Delayed data being free: search summary of IBKR Campus only. Xetra non-professional fee waiver (Deutsche Boerse exchange access fee waived since Feb 1, 2021): search summary of IBKR Knowledge Base article 1852 only; I could not read the article text: UNVERIFIED. IBKR's Xetra fee page confirms the IBIS code ("Xetra (IBIS) Fees") and states "Transaction fees are waived for Retail Orders executed on Xetra when Xetra is selected according to Best Execution Policy i.e., Direct Routed Retail orders are charged Regular Retail rates."

### Rate limits

Global: "10 requests per second for each authenticated username -- that is, each Web API session". Penalty box: "10 minutes" on the Trading page, "15 minutes" on the v1 pacing page (conflict). Edge Functions share egress IPs, so a 429 could penalise all functions. Per endpoint: snapshot 10/s; orders, trades, pnl/partitioned, portfolio/accounts 1 per 5 s; `/tickle` 1/s; `/sso/validate` 1/min; `/pa/*` 1 per 15 min; history 10 req/s or 50 req/min.

### Exchange and contract semantics (question E)

- IBKR: "For a single product trading in multiple markets, IB will assign distinct conids for each combination of product and currency. For instance, AAPL stock trading in USD in the United States has a different conid than the same AAPL stock trading in MXN." So Apple on Xetra (EUR) is a separate conid from the USD one. The `/trsrv/stocks` example returns several `contracts` per symbol (NASDAQ, MEXI, ...). Apple's actual Xetra conid was not retrieved.
- Codes: Xetra = IBIS (IBKR fee page). A third-party blog also mentions IBIS2 (low reliability). AEB and SMART come from background knowledge and were not verified in a primary source.
- Listing vs execution venue: trades return `listing_exchange` ("the primary listing exchange of the contract") and `exchange` (venue); orders return `listingExchange` (example "NASDAQ.NMS").
- Same share class vs depositary receipt: no doc I read describes a field for this. Inference: compare ISIN and name across conids. UNVERIFIED that the Web API returns ISIN in `secdef/info` or `/trsrv/secdef`.

### Flex Web Service facts (question C)

- Enable: Client Portal, Reporting, Flex Queries, "Flex Web Service Configuration", tick "Flex Web Service Status", Save. A token "can be specified to remain active anywhere between 6 hours and 1 year" and can be IP-restricted.
- Calls: `GET https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t={token}&q={queryId}&v=3` then `.../GetStatement?t={token}&q={referenceCode}&v=3`. Optional `p` (days) or `fd`/`td` date range.
- Limits: "1 request per second. A maximum of 10 requests per minute" per token. Error 1018 on breach; 1012 token expired; 1013 IP restriction; 1019 "Statement generation in progress. Please try again shortly."
- Output: returned as `text/plain;charset=UTF-8`; Client Portal guide says output format "TEXT or XML".
- Sections available in an Activity Flex Query include Trades, Cash Transactions, Open Positions, Corporate Actions, Commission Details, Transfers (ACATS, Internal), Incoming/Outgoing Trade Transfers, Statement of Funds, Realized and Unrealized Performance Summary in Base, Mark-to-Market Performance Summary, Change in Dividend Accruals, Open Dividend Accruals (Activity Flex Query Reference, updated Mar 20, 2025). Saved queries cover the four previous calendar years plus the current year.
- Deno feasibility: two plain HTTPS GETs plus XML/text parsing. Feasible. Latency (T+1?) not documented in what I read: UNVERIFIED.

---

## 4. Architecture options

### Option A: OAuth 1.0a called directly from Supabase Edge Functions with pg_cron keep-alive

One-time self-service portal registration. Secrets (consumer key, access token and secret, private signing and encryption keys, DH prime) go in Supabase secrets. A cron job calls an Edge Function each minute: it signs `/tickle` with the LST, recreates the LST (RSA-signed request plus DH) when it expires or after the daily reset, and re-runs `/ssodh/init` when `/iserver/auth/status` shows `authenticated: false`. The order modal calls functions that do snapshot, whatif and order calls synchronously.

- Pros: only option meeting "no human re-login", no stored username/password, no extra machine, fits the stack.
- Cons: unsupported for individuals; IBKR could disable the consumer key; the stored access token secret and private keys can place trades; LST and session behaviour at the nightly reset unverified; the shared username is still displaced by TWS/mobile logins; activation delay up to days; needs a JS crypto implementation (a community JSR package `@quentinadam/ibkr` exists, not evaluated); polling only with 1 req/5 s order/trade limits; shared egress IP rate-limit risk.
- Honesty: "perpetual connectivity" still cannot be claimed (5 min idle drop, nightly reset, displacement, policy risk).

### Option B: user-run Client Portal Gateway plus local bridge syncing to Supabase (architectural exception)

The user runs CPGW on a machine they control and logs in daily (browser plus 2FA). A small local agent on the same machine calls `/tickle` each minute, polls portfolio/orders/trades and pushes them to Supabase. It also polls an "order intents" table and places or cancels orders. The hosted app never touches IBKR.

- Pros: officially supported for individuals; no stored credentials; consistent with the brief's prohibitions.
- Cons: breaks "no other server"; needs an always-on PC or small device with Java; daily manual login with 2FA (automation only via credential-storing tools like IBeam, which the brief forbids); trading unavailable when the machine is off or the session is expired, so the UI must show "disconnected"; quote latency from the polling chain; the bridge is a new security-sensitive component.

### Option C: read-only analytics via Flex Web Service, no live trading

User creates an Activity Flex Query once. A cron-triggered Edge Function runs SendRequest, waits, runs GetStatement, parses and loads Postgres.

- Pros: supported for individuals; plain HTTPS; no session, no 2FA, no displacement; token valid up to one year; covers trades, cash transactions (dividends, withholding), positions, corporate actions, transfers, commissions, realized/unrealized summary.
- Cons: no quotes or order entry; freshness not documented; 10 requests/min limit; token is a read-everything secret; do not enable IP restriction because Edge Function egress IPs are not fixed.

### Recommendation

Build C now: the only supported, fully hosted, password-free part, covering history, dividends and realized P&L. For live trading, adopt B as the default and design the UI to show "disconnected / re-login needed" honestly. Run A only as a time-boxed paper-account spike after IBKR API Support confirms in writing that OAuth 1.0a is permitted for the user's account type (Ireland vs LLC). If confirmed, promote A and retire B.

---

## 5. User setup checklist (recommended: C for history, B for trading, paper first)

1. Confirm the live account is fully open, funded and IBKR Pro (required even to use paper). Record the entity (Ireland vs LLC).
2. Enable a supported 2FA method (IB Key, Handy Key, SMS, DSC+). Security Code Card is not supported for API login.
3. Create a second username for API use (IBKR Knowledge Base article referenced by IBKR docs: https://ibkr.info/node/1004) so TWS/mobile logins do not displace the API session. Market data is billed per username.
4. Paper account: Client Portal, head-and-shoulders icon, Settings, Account Configuration, Paper Trading Account. Note the paper username and account number, reset the paper password, optionally link market data. Log into CPGW with the paper username.
5. Market data: complete the annual Market Data API Acknowledgement (Settings, Market Data Subscriptions, Market Data API Agreement) or 6509 shows `O`. For live Xetra quotes, subscribe to the Xetra Core spot data (reportedly fee-waived for non-professionals; verify in Client Portal). Delayed quotes need no subscription per the summary found. Declare professional/non-professional status honestly.
6. Flex: Client Portal, Performance and Reports, Flex Queries. Create an Activity Flex Query with Trades, Cash Transactions, Open Positions, Corporate Actions, Transfers, Commission Details, Realized and Unrealized Performance Summary. Note the Query ID. Enable Flex Web Service, generate a token (6 hours to 1 year), leave IP restriction off, store the token as a Supabase secret.
7. Bridge machine: install Java, download and unzip the Client Portal Gateway, run `bin\run.bat root\conf.yaml` (Windows), open `https://localhost:5000`, log in daily. On macOS change the port (5000 is often occupied).
8. On paper, place a test limit order on an Xetra (IBIS) instrument and a SMART-routed one. Record `valid_exchanges`, conids, `whatif` commission and the 6509 code.
9. Optional OAuth spike: first open an IBKR support ticket asking whether OAuth 1.0a self-service is permitted for the account. Only after a yes, follow the self-service steps (see section 2, setup row) on the paper user first.

---

## 6. Open questions and not verified

- Whether OAuth 1.0a self-service for an individual account is permitted under the portal terms (behind login). Official docs say institutional only; community says it works.
- LST lifetime beyond the "24 hour period"; behaviour at the nightly reset and weekend maintenance; whether the access token can expire without manual revocation.
- Whether a cron tick every N minutes suffices or the brokerage session must be recreated after the reset. Docs: 5 min idle limit, tickle about every 60 s.
- Conflicts between IBKR pages: reset 00:00 CEST vs 01:00 CEST; penalty box 10 vs 15 minutes.
- Concurrent session limit under OAuth: docs only state one brokerage session per username.
- ISIN search; ISIN in contract responses; how to prove a Xetra EUR line is the same share class and not a depositary receipt; Apple's Xetra conid.
- Directed-routing syntax (`conid@IBIS` vs `listingExchange`) and the AEB code.
- `cOID` uniqueness enforcement.
- Paper account market data (delayed only?) and OAuth on paper.
- Free delayed data and the Xetra non-professional fee waiver: search summaries only.
- Flex data latency, effect of Flex calls on trading sessions (no evidence found).
- Client agreement clause on self-hosted apps; Ireland-entity API restrictions.
- No 2025-2026 outage list found; only the changelog below.

Changelog items relevant to the app (read 2026-10-15):
- Oct 10, 2026: trades `side` values N, X, L, A, F, E, U documented.
- Sep 9, 2026: history pacing 10 req/s or 50 req/min; `/hmds/scanner` deprecated; `secType` removed from `/iserver/secdef/search`.
- Apr 14, 2026: "Websocket market data requests using the SMD topic will terminate after 10 minutes."
- Mar 17, 2026: order status descriptions updated.
- Mar 12, 2026: OAuth 2.0 websockets use `sessionToken` query parameter.
- Feb 11, 2026: `/unsubscribe` and `/unsubscribeall` documented; `/md/regsnapshot` no longer supported.
- Jan 6, 2026: fundamental data tags (dividend, P/E, etc.) deprecated.
- Dec 10, 2025: snapshot limited to 100 conids and 50 fields.

---

## 7. Sources (all accessed 2026-10-15; IBKR docs carry no version number; changelog newest entry Oct 10, 2026)

| URL | Title | Used for |
|---|---|---|
| https://www.interactivebrokers.com/campus/ibkr-api-page/web-api-trading/ | Trading Web API (IBKR Campus) | individual access, third-party process, pacing, sessions, market data, orders, reset times |
| https://www.interactivebrokers.com/campus/ibkr-api-page/webapi-doc/ | Web API Documentation (IBKR Campus) | same content, organization access list |
| https://www.interactivebrokers.com/campus/ibkr-api-page/web-api-changelog/ | Web API Changelog | 2025-2026 changes |
| https://www.interactivebrokers.com/docs/web-api/llms.txt | Web API docs index | list of .md pages |
| https://www.interactivebrokers.com/docs/web-api/getting-started.md | Getting Started | retail uses CPGW |
| https://www.interactivebrokers.com/docs/web-api/authentication/introduction.md | Authentication Introduction | account types per method |
| https://www.interactivebrokers.com/docs/web-api/authentication/sessions.md | Session Authentication | two-tier sessions |
| https://www.interactivebrokers.com/docs/web-api/authentication/trading.md | Trading Sessions | init steps, 5 min idle |
| https://www.interactivebrokers.com/docs/web-api/authentication/multiple-sessions.md | Managing Multiple Sessions | one session per username |
| https://www.interactivebrokers.com/docs/web-api/authentication/paper.md | Using a Paper Account | paper username steps |
| https://www.interactivebrokers.com/docs/web-api/authentication/faq.md | Authentication FAQ | 24 h session, tickle, timeouts |
| https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/installation-authentication.md | CPGW Installation | setup |
| https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/limitations-of-the-client-portal-gateway.md | CPGW Limitations | same-machine requirement |
| https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/client-portal-gateway-faq.md | CPGW FAQ | no automated authentication, daily login |
| https://www.interactivebrokers.com/docs/web-api/authentication/oauth-1a/introduction.md | OAuth 1.0a Introduction | scope |
| https://www.interactivebrokers.com/docs/web-api/authentication/oauth-1a/first-party-oauth/registration-process.md | OAuth 1.0a First Party Registration | institutions, activation delay |
| https://www.interactivebrokers.com/docs/web-api/authentication/oauth-1a/first-party-oauth/first-party-o-auth-workflow.md | First Party OAuth Workflow | LST 24 h, init |
| https://www.interactivebrokers.com/docs/web-api/authentication/oauth-1a/lst/compute-live-session-token.md | Compute the Live Session Token | DH and HMAC flow |
| https://www.interactivebrokers.com/docs/web-api/authentication/oauth-1a/authenticated-requests.md | Standard Structure for Authenticated Requests | HMAC-SHA256 signing |
| https://www.interactivebrokers.com/docs/web-api/authentication/oauth-2/introduction.md | OAuth 2.0 Introduction | eligibility |
| https://www.interactivebrokers.com/docs/web-api/authentication/oauth-2/register.md | OAuth 2.0 Registration Process | "not available to Individual account structures" |
| https://www.interactivebrokers.com/docs/web-api/authentication/oauth-2/bearer-token.md | OAuth 2.0 Bearer Token | 24 h assertion |
| https://www.interactivebrokers.com/docs/web-api/trading/getting-started/trading-access-for-individuals.md | Trading Access for Individuals | Pro, funded |
| https://www.interactivebrokers.com/docs/web-api/trading/instrument-discovery/contract-i-ds.md | Contract IDs | per-currency conids |
| https://www.interactivebrokers.com/docs/web-api/v1/regular-server-maintenance.md | Regular Server Maintenance | 00:00 CEST reset |
| https://www.interactivebrokers.com/docs/web-api/v1/pacing-limitations.md | Pacing Limitations (v1) | rate limits |
| https://www.interactivebrokers.com/docs/web-api/v1/requirements-limitations/supported-two-factor-authentication-2-fa.md | Supported 2FA | 2FA methods |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/session/ping-the-server.md | Ping the server (/tickle) | tickle |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/session/initialize-brokerage-session.md | Initialize Brokerage Session | publish/compete |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/session/validate-sso.md | Validate SSO | CPGW and OAuth 2.0 only |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/market-data/live-market-data-snapshot.md | Live Market Data Snapshot | pre-flight |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/market-data/market-data-availability.md | Market Data Availability | 6509 codes |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/market-data/market-data-fields.md | Market Data Fields | field numbers |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/orders/preview-order-what-if-order.md | Preview / WhatIf Order | commission response |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/orders/place-order.md | Place Order | order body, cOID |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/order-monitoring/trades.md | Trades | executions, 7 days |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/order-monitoring/order-status-value.md | Order Status Value | status vocabulary |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/contract/find-all-info-and-rules-for-a-given-contract.md | Info and Rules | valid_exchanges |
| https://www.interactivebrokers.com/docs/web-api/v1/endpoints/contract/search-contract-by-symbol.md | Search Contract by Symbol | secdef/search |
| https://www.interactivebrokers.com/docs/web-api/flex-web-service/introduction.md (and sub-pages enable-and-create-access-token, generate-the-report, retrieve-the-report, error-codes) | Flex Web Service | token 6 h to 1 year, v=3, limits, errors |
| https://www.ibkrguides.com/clientportal/performanceandstatements/flex.htm | Flex Queries (Client Portal guide, updated Oct 30, 2025) | TEXT or XML |
| https://guides.interactivebrokers.com/reportingreference/reportguide/activity%20flex%20query%20reference.htm | Activity Flex Query Reference (updated Mar 20, 2025) | sections |
| https://www.interactivebrokers.co.uk/en/accounts/fees/IBIS-StkFees.php | Xetra (IBIS) Fees | IBIS code, retail routing note |
| https://raw.githubusercontent.com/Voyz/ibind/master/docs/oauth/oauth_1a.md | ibind: OAuth 1.0a (community) | portal steps, individual reports, activation delay |
| https://github.com/Voyz/ibind (README) | ibind | headless OAuth 1.0a, IBeam |
| https://red.applefritter.com/r/algotrading/comments/1iivx90/ibkr_web_api | Reddit mirror, r/algotrading Feb 2025 (search summary only) | community claim about portal terms |
| https://ibkb.interactivebrokers.com/nl/article/1852 | IBKR Knowledge Base 1852 (text not readable; search summary only) | Xetra fee waiver claim, UNVERIFIED |
| https://www.bankeronwheels.com/interactive-brokers-stock-exchanges-codes/ | Third-party blog (search summary only) | IBIS2 mention, low reliability |
