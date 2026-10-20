# Charting, Static Hosting and Frontend Stack Research

Research / access date for all sources: **2026-10-15**. Method: primary sources (npm registry JSON, GitHub API, vendor docs) fetched via WebFetch. Fetched pages were summarised by a small model, so quotes below are as returned by the fetch tool and must be re-checked against the linked page before being used in any compliance document. Items I could not verify are marked **UNVERIFIED**.

## 1. Executive recommendations

**Chart library: TradingView Lightweight Charts v5.2.1 (Apache-2.0).** It is the only candidate that natively covers the brief (candlestick, line, area, wheel/pinch zoom, drag pan, price-scale drag, crosshair, touch, light/dark theming) in a small canvas library. It is actively maintained (v5.2.1 released 2026-08-12; repo last pushed 2026-10-13; 125 open issues). It has a documented plugin API (series primitives) plus whitespace data and `rightOffset` for the forward space the regression channel needs. Commercial use is permitted by Apache-2.0, but there is an **attribution obligation** (section 2.2) that cannot be silently dropped; the built-in `attributionLogo` (default `true`) satisfies it. Runner-up: KLineChart 10.1.0 (Apache-2.0, no attribution found, built-in drawing overlays, less documented). Apache ECharts 6.1.0 is the fallback if attribution is unacceptable, but financial interaction (price-scale drag, kinetic pan) is weaker and the package is large.

**Hosting: Cloudflare free plan, using Workers Static Assets (Pages is an acceptable alternative).** Static asset requests are "free and unlimited", custom domains, `_headers`, `_redirects` and SPA fallback (`not_found_handling = "single-page-application"`) are supported, and the Cloudflare terms excerpt I found has no non-commercial clause (only a ban on handling card data on free-service properties). Cloudflare's Pages docs now say "Start new projects with Workers." Reject Vercel Hobby (contractual non-commercial-only; ads/affiliate/payments would breach it) and GitHub Pages (terms prohibit running an online business, commercial transactions, SaaS). Netlify Free, Render and Firebase Spark are workable fallbacks.

**Stack (verified current on 2026-10-15):** Vite 8.3.4 + @vitejs/plugin-react 6.1.2 (peer `vite ^8`), React 19.3.1 (React Compiler 1.0 stable, optional), React Router 8.4.0 (library mode) or TanStack Router 1.170.x, TanStack Query 5.104.2, Tailwind CSS 4.3.3 + shadcn/ui CLI, vite-plugin-pwa 2.0.0 with `injectManifest`, Vitest 5.0.4, Playwright 1.64.1, Zod 4.6.7, supabase-js 2.117.3. **Incompatibility found:** npm `latest` TypeScript is 7.0.2 but typescript-eslint 8.71.2 declares peer `typescript >=4.8.4 <6.1.0`. Pin TypeScript to a 6.x release if ESLint + typescript-eslint is used, or use Biome 2.5.15. Date/time: `Intl.DateTimeFormat` + `date-fns` 4.4.0 with `@date-fns/tz` 1.5.0 (or Luxon 3.7.2). Do not rely on native Temporal: Safari/iOS has not shipped it per MDN browser-compat-data, and Bun 1.3.14 predates Bun's Temporal support (1.4.0).

## 2. Charting comparison

### 2.1 Table

| Library | Version (npm latest) | Licence | Commercial use | Maintenance | Size | Candles/line/area | Zoom/pan/price-scale/touch | Right-extension of overlay lines |
|---|---|---|---|---|---|---|---|---|
| **Lightweight Charts** | 5.2.1 (2026-08-12) | Apache-2.0 + attribution (NOTICE text + link to tradingview.com) | Yes, with attribution | Active: 5.0.9 (2025-10-01), 5.1.0 (2025-12-16), 5.2.0 (2026-04-24), 5.2.1 (2026-08-12), plugins-2026-09-16; 125 open issues; 17,576 stars | One dependency, fancy-canvas 2.1.0; gzip size **UNVERIFIED**; v5 tree-shakes series types | All native | Wheel/pinch zoom, drag pan, price-scale drag, crosshair, touch are standard features (not individually re-verified in docs this session) | Whitespace data, `rightOffset`/`rightOffsetPixels`, extra line series with future timestamps, series primitives |
| **KLineChart** | 10.1.0 | Apache-2.0; no watermark/attribution requirement mentioned in README | Yes | Release cadence/issues **UNVERIFIED** | README: "zero dependencies, only 40k under gzip compression" (README claim); npm unpacked 2.9 MB | K-line (candles), line, area | Mobile support claimed; built-in "line drawing models" | Overlay API exists; behaviour beyond last bar **UNVERIFIED** |
| **Apache ECharts** | 6.1.0 | Apache-2.0 | Yes | Large active project; not individually checked | npm unpacked 60 MB (tree-shakeable; bundle **UNVERIFIED**) | Candlestick, line, area | `dataZoom` inside/slider (wheel/pinch, pan); no financial price-scale drag | `markLine` with `coord`; x beyond last category needs extra empty categories or a time axis (**UNVERIFIED**, doc fetch failed) |
| **Chart.js + chartjs-chart-financial** | plugin 0.2.1 published 2024-03-23 | MIT | Yes | Plugin stale (about 19 months without release) | n/a | Candlestick/OHLC via plugin | Needs zoom plugin; weak at 2,600 bars | Annotation plugin possible; not recommended |
| **Plotly.js** | 4.1.2 (as returned by registry) | MIT | Yes | Active (not deeply checked) | npm unpacked 98 MB; large bundles | Candlestick, line, area | Zoom/pan, rangeslider; heavy on mobile | Shapes accept any x; heavy |
| **uPlot** | 1.6.32 | MIT | Yes | Not checked | 545 KB unpacked | Line/area; candles via custom draw hooks | Fast, minimal; touch zoom DIY | DIY via hooks |
| **react-financial-charts** | 2.0.1 | MIT | Yes | Maintenance **UNVERIFIED** (publish date not retrieved) | n/a | Candlestick, OHLC, area, line; 60+ indicators | d3-based | DIY |
| **Highcharts Stock** | 13.1.1 | Proprietary; npm licence field "https://www.highcharts.com/license" | Free only for "a non-commercial purpose authorized by Highsoft which is governed by separate terms"; commercial = Internal / SaaS / OEM licences, prices on request (public websites need SaaS) | Active | n/a | All | Full | Annotations/plot lines (not verified) |
| **amCharts 5 (Stock)** | 5.21.2 | npm field "SEE LICENSE IN LICENSE" (linkware per registry summary) | Free linkware with branding; paid Basic licence $80/seat/yr or $180 perpetual for public sites (Stock Chart had 20% discount at fetch) | Active | n/a | All | Full | Supported |
| **AnyChart** | not checked | Free licence "for non-commercial/education/NPO"; paid from $49 ("Next Unicorn") | Paid | not checked | n/a | All | Full | n/a |
| **D3 custom** | n/a | ISC | Yes | n/a | Build everything | DIY | DIY | Full freedom, large effort |

### 2.2 Lightweight Charts licence, verbatim clauses

- README: "This license requires specifying TradingView as the product creator. You shall add the "attribution notice" from the NOTICE file and a link to https://www.tradingview.com/ to the page of your website or mobile application that is available to your users." ([README](https://raw.githubusercontent.com/tradingview/lightweight-charts/master/README.md))
- README: "As thanks for creating this product, we'd be grateful if you add it in a prominent place."
- README: using the `attributionLogo` chart option to display an appropriate link to https://www.tradingview.com/ on the chart itself satisfies the link requirement (fetch summary; check exact wording).
- NOTICE file (as returned): "TradingView Lightweight Charts(TM) Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/" ([NOTICE](https://raw.githubusercontent.com/tradingview/lightweight-charts/master/NOTICE)). The fetch tool rendered the copyright symbol oddly; copy the NOTICE text from the file itself.
- LICENSE (Apache-2.0): redistributors must "retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work" and include "a readable copy of the attribution notices contained within such NOTICE file". Header: "Copyright 2023 TradingView, Inc. Licensed under the Apache License, Version 2.0".
- API docs `LayoutOptions.attributionLogo`: "Display the TradingView attribution logo on the main chart pane." Default `true`. The docs say the licence requires attribution, using the logo satisfies it, and users who already provide proper attribution elsewhere may disable it (paraphrase by the fetch summariser). ([LayoutOptions](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/LayoutOptions))
- **Is hiding permitted?** Yes, if the NOTICE text and a link to https://www.tradingview.com/ appear on a user-visible page of the site (for example footer or About page) and `attributionLogo: false` is set. Safest: leave `attributionLogo` default AND add the NOTICE line + link to the footer. A web-search result states no paid tier removes the requirement (secondary source). No difference in obligation for commercial vs non-commercial use was found.
- The README also notes parts of tslib under BSD Zero Clause.

### 2.3 Lightweight Charts: right-extension mechanism

Documented facts:
- v5 API: `chart.addSeries(CandlestickSeries, options)`; series types are imported individually; markers moved to `createSeriesMarkers`; watermarks became pane primitives; plugin interfaces renamed (`IPrimitivePaneView`). ([migration guide](https://tradingview.github.io/lightweight-charts/docs/migrations/from-v4-to-v5))
- React: official tutorial uses `useRef` container plus `useEffect` calling `createChart`, cleanup with `chart.remove()` and a resize listener; Strict Mode not explicitly addressed. ([React tutorial](https://tradingview.github.io/lightweight-charts/tutorials/react/simple))
- `rightOffset`: "The margin space in bars from the right side of the chart." (default 0). `rightOffsetPixels`: "The margin space in pixels from the right side of the chart. This option has priority over `rightOffset`." `fixRightEdge`: "Prevent scrolling to the right of the most recent bar." `shiftVisibleRangeOnNewBar` default true. ([TimeScaleOptions](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/TimeScaleOptions))
- `timeToCoordinate` returns "X coordinate of that time or `null` if no time found on time scale."; `logicalToCoordinate` returns null "if the chart doesn't have data". ([ITimeScaleApi](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ITimeScaleApi)). So a time absent from the scale yields null; a logical index past the last bar is documented as null only when there is no data (**not tested**).
- Plugin types: series primitives ("drawing tools, annotations, or overlays that interact with series data"), pane primitives, custom series. ([plugins intro](https://tradingview.github.io/lightweight-charts/docs/plugins/intro)). The official trend-line example uses `series.priceToCoordinate` and `timeScale.timeToCoordinate` and returns early on null. ([trend-line.ts](https://raw.githubusercontent.com/tradingview/lightweight-charts/master/plugin-examples/src/plugins/trend-line/trend-line.ts))

Design options (my inferences; need a spike):
1. **Extra LineSeries with future timestamps.** Five `LineSeries`, each with two points: (first of the 2,500 bars, y0) and (a future timestamp, y1). The time scale covers the union of all series' times, so lines render into empty space. Set `rightOffset`/`rightOffsetPixels` for the margin. Because LWC positions by index, add one whitespace point (`{ time }` only) per future bar to the candle series so future x spacing is correct. The whitespace doc page was not found (URL I guessed returned 404), so that doc link is **UNVERIFIED**.
2. **Series primitive.** Draw the five lines in a pane view renderer with x from `timeScale.logicalToCoordinate(lastIndex + N)` and y from `series.priceToCoordinate(value)`. No data-model side effects, redraws on zoom/pan. Needs the right margin or whitespace so the area is visible. Extrapolation beyond the last bar is **not tested**.
3. Custom series: heavier, not needed.

### 2.4 KLineChart (runner-up)

README: "zero dependencies, only 40k under gzip compression", built-in indicators and line drawing models, mobile support, TypeScript types, Apache-2.0; no watermark or attribution requirement mentioned. The excerpt did not describe how overlay points map to timestamps beyond the last bar, so the right-extension mechanism is **UNVERIFIED**. Sources: [npm](https://registry.npmjs.org/klinecharts/latest), [README](https://raw.githubusercontent.com/klinecharts/KLineChart/main/README.md).

### 2.5 Recommendation
Lightweight Charts 5.x. In a spike, test option 1 first (simple, data-driven), fall back to option 2 if crosshair/price-label noise from the extra series is unwanted. Range buttons via `timeScale().setVisibleRange` / `setVisibleLogicalRange`.

## 3. Hosting comparison

| Host / plan | Free-tier limits (verified) | Commercial use on free tier (quote) | SPA fallback / headers | Verdict |
|---|---|---|---|---|
| **Cloudflare Workers Static Assets (Free)** | 20,000 files per version; 25 MiB per file; "Requests to static assets are free and unlimited."; "There is no additional cost for storing Assets." Free Workers: 100,000 requests/day for Worker invocations (not static assets). Workers Builds free minutes **UNVERIFIED** | Cloudflare terms: only restriction found is Section 2.2.1(h) "process or collect personal or business credit card information on any web property that is receiving Free Services". No non-commercial clause found | `"not_found_handling": "single-page-application"`: "When an incoming request does not match a file in the `assets.directory`, Workers will serve the contents of the `/index.html` file with a `200 OK` status."; `_headers` supported (100 rules, 2,000 chars/line, not applied to Worker-generated responses); `_redirects` supported | **Recommended** |
| **Cloudflare Pages (Free)** | 500 builds/month, 1 concurrent; 20,000 files; 25 MiB per file; 100 custom domains; `_headers` 100 rules; `_redirects` 2,000 static + 100 dynamic | same terms | `_headers`, `_redirects` | OK; docs: "Workers supports most Pages use cases and offers a broader feature set. It is Cloudflare's primary platform for building applications. Start new projects with Workers." Pages not deprecated per third-party morphllm.com |
| **Vercel Hobby** | Fast Data Transfer first 100 GB; 1,000,000 CDN requests; 100 deployments/day | "**Hobby teams** are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan." Commercial = any deployment "used for the purpose of financial gain of **anyone** involved in **any part of the production** of the project". Examples include payment requests, advertising sale of a product or service, receiving payment to create/update/host, affiliate linking as primary purpose, "The inclusion of advertisements, including ... Google AdSense". "Asking for Donations **does not** fall under commercial usage." | rewrites via vercel.json | Only if strictly non-commercial; not recommended |
| **Netlify Free** | Credit-based: 300 credits/month, hard limit, 1 concurrent build; credits: production deploy 15, bandwidth 20/GB, web requests 2 per 10k | No plan-specific commercial restriction in Terms of Use; it defers to the Acceptable Use Policy and Self-Serve Subscription Agreement, which were **not** read (**UNVERIFIED**) | `_redirects`/`_headers`/netlify.toml (not fetched) | Fallback |
| **GitHub Pages** | Site <= 1 GB; 100 GB/month soft bandwidth; 10 builds/hour soft; 10 min deploy timeout | "not intended for or allowed to be used as a free web-hosting service to run your online business, e-commerce site" or for "facilitating commercial transactions or providing commercial software as a service (SaaS)" | No native SPA fallback (404.html trick returns 404 status; not fetched); custom domain HTTPS not re-verified | Hobby only; risky |
| **Firebase Hosting (Spark)** | 10 GB storage; 360 MB/day transfer; custom domain + SSL | Pricing page has no commercial restriction (terms **UNVERIFIED**) | firebase.json rewrites (not fetched) | 360 MB/day is tight |
| **Render static** | "Static sites are fast and free to deploy"; monthly bandwidth amount **UNVERIFIED**; 2 custom domains on Hobby | not found (**UNVERIFIED**) | Redirect/rewrite rules in dashboard; custom headers | Fallback |

**GitHub Actions:** GitHub Free plan has "2,000" monthly minutes for private repos on standard runners; "The use of standard GitHub-hosted runners is free: In public repositories". Linux 2-core $0.006/min, Windows 2-core $0.010/min, macOS $0.062/min. ([docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions))

**Verdict:** Cloudflare free plan via Workers Static Assets.

## 4. Stack versions (npm registry `latest`, accessed 2026-10-15)

| Package | Version | Notes / incompatibilities |
|---|---|---|
| vite | 8.3.4 | Node `^20.19.0 \|\| >=22.12.0` |
| @vitejs/plugin-react | 6.1.2 | peer `vite ^8.0.0` only |
| react | 19.3.1 | React Compiler 1.0 stable (react.dev), supports React 17/18/19, Babel plugin, Vite supported; optional |
| react-router | 8.4.0 | peer react >=19.2.7; Node >=22.22.0; use library mode as SPA; no built-in schema validation of search params (use Zod). The brief said v7; registry shows 8.x, migration notes not read |
| @tanstack/react-router | 1.170.44 | peer react 18/19; type-safe search params with validators; more setup |
| @tanstack/react-query | 5.104.2 | peer react ^18 \|\| ^19. `refetchInterval` + `refetchIntervalInBackground`: docs page fetch returned 404, behaviour **UNVERIFIED** against current docs |
| tailwindcss | 4.3.3 | use `@tailwindcss/vite`; CSS `@import "tailwindcss";` |
| shadcn CLI | `shadcn@latest init -t vite` | Docs show Tailwind v4, tsconfig `@/*` path alias and vite alias; docs use `pnpm dlx`; Bun equivalent `bunx --bun shadcn@latest init` not verified |
| vite-plugin-pwa | 2.0.0 | peer vite ^3.1 to ^8; workbox ^7.4.1; `strategies: 'injectManifest'`, `srcDir`, `filename`; SW: `precacheAndRoute(self.__WB_MANIFEST)`; add `"WebWorker"` to tsconfig lib and `declare let self: ServiceWorkerGlobalScope` |
| vitest | 5.0.4 | peer vite ^6.4 \|\| ^7 \|\| ^8; Node ^22.12 \|\| ^24 \|\| >=26 |
| @testing-library/react | 16.3.3 | react 18/19; needs @testing-library/dom ^10 |
| @playwright/test | 1.64.1 | Node >=20; Windows install under Bun not tested |
| happy-dom | 21.0.1 | Node >=20 |
| jsdom | 30.1.2 | Node ^22.22.2 \|\| ^24.15.0 \|\| >=26 |
| typescript | **7.0.2** (npm latest) | **typescript-eslint 8.71.2 peer `typescript >=4.8.4 <6.1.0` conflicts.** TS 6.x release dates not retrieved |
| typescript-eslint | 8.71.2 | peer eslint ^8.57 \|\| ^9 \|\| ^10 |
| eslint | 10.12.0 | flat config; Node ^20.19 \|\| ^22.13 \|\| >=24 |
| @biomejs/biome | 2.5.15 | alternative linter+formatter |
| zod | 4.6.7 | v4 line |
| @supabase/supabase-js | 2.117.3 | Node >=22 |
| date-fns / @date-fns/tz | 4.4.0 / 1.5.0 | `TZDate` for Europe/Sofia and exchange zones |
| luxon | 3.7.2 | alternative |

Notes:
- **Temporal** (MDN BCD): Chrome 144, Edge 144, Firefox 139, Deno 2.7, Node 26.0.0, Bun 1.4.0; Safari "preview" (not released); Safari iOS not supported. iOS PWA users are not covered, so use date-fns/Luxon or a polyfill (`@js-temporal/polyfill`, `temporal-polyfill`). Safari status after the BCD snapshot is **UNVERIFIED**.
- `Intl.DateTimeFormat` with `timeZone: 'Europe/Sofia'` or `'America/New_York'` suits display; date arithmetic across DST needs date-fns-tz/Luxon/Temporal.
- **Bun on Windows** (secondary sources from search snippets, not reproduced): `bun x` has argument-passing problems on Windows; `bun run` can route `#!/usr/bin/env node` tools through Bun's node shim when Node is not on PATH; Vitest relies on Node `vm` support that Bun lacks. Practical advice: keep Node installed (Vite 8, Vitest 5 and ESLint 10 need Node 20.19/22.12+ anyway), use Bun as package manager, run Vitest under Node. **UNVERIFIED**.
- Workspaces: not researched.

## 5. PWA checklist

- Manifest: `name`, `short_name`, `start_url`, `scope`, `display: "standalone"`, `theme_color`, `background_color`, icons 192 and 512 PNG plus a maskable icon.
- iOS: Web Push requires an installed Home Screen web app, iOS 16.4+, manifest `display: standalone`, and a permission request from a user gesture (Apple developer docs via fetch summary). Add `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` (180x180). Apple-specific meta tags not verified.
- Service worker via vite-plugin-pwa `injectManifest`: `precacheAndRoute(self.__WB_MANIFEST)`, `cleanupOutdatedCaches()`, custom `push` and `notificationclick` handlers, `SKIP_WAITING` message for update prompt, or `skipWaiting()` + `clientsClaim()` for auto update.
- Scope: serve `/sw.js` from the site root so scope is `/`. With Cloudflare `not_found_handling = "single-page-application"` the SW file is served as a real asset (fallback applies only when no asset matches). Set `Cache-Control: no-cache` for `/sw.js` and `/manifest.webmanifest` in `_headers`.
- Cache strategy: precache the static build only; never cache Supabase Auth/REST/Edge Function responses (requests to `*.supabase.co`, or carrying `Authorization`/`apikey`): `NetworkOnly` or no route at all. Exclude auth callback paths from navigation fallback.
- Push: VAPID keys, subscription stored in Supabase, sent from an Edge Function; always show a notification per push (iOS requirement; not verified this session).
- Attribution: footer/About page with the Lightweight Charts NOTICE text and tradingview.com link.

## 6. Open questions and unverified items

1. Lightweight Charts: does `logicalToCoordinate` return a usable x past the last bar (primitive approach)? Whitespace doc URL not found. Needs a spike.
2. Lightweight Charts gzip size not measured (bundlephobia returned no numbers); measure with `vite build` and a visualizer.
3. KLineChart cadence/issues and right-extension, ECharts `markLine` beyond last category, uPlot/Plotly/react-financial-charts maintenance dates, Highcharts non-commercial terms text and prices, AnyChart terms: not retrieved or too thin to quote.
4. amCharts: the fetched 20250624 licence page said "You may not remove any product identification, copyright notices or proprietary restrictions from the Licensed Software (except for the branding link on the chart itself, which you may remove)" and had no linkware clause; the registry/summary said linkware. Contradiction unresolved.
5. Cloudflare: Workers Builds free-plan minutes; full Self-Serve Subscription Agreement not read (only a summary of Section 2.2.1(h)).
6. Netlify AUP/Subscription Agreement, Firebase and Render terms not read; GitHub Pages 404.html SPA fallback and custom-domain HTTPS not re-fetched.
7. TanStack Query `refetchIntervalInBackground` docs 404; React Router 8 vs 7 differences not read.
8. TypeScript 6.x release info and typescript-eslint plans for TS 7 not verified.
9. Safari Temporal status after the BCD snapshot; Bun 1.3.14 Windows issues not reproduced; Playwright on Windows with Bun; Bun workspaces.

## 7. Sources (all accessed 2026-10-15)

- https://raw.githubusercontent.com/tradingview/lightweight-charts/master/LICENSE
- https://raw.githubusercontent.com/tradingview/lightweight-charts/master/NOTICE
- https://raw.githubusercontent.com/tradingview/lightweight-charts/master/README.md
- https://tradingview.github.io/lightweight-charts/docs/api/interfaces/LayoutOptions
- https://tradingview.github.io/lightweight-charts/docs/api/interfaces/TimeScaleOptions
- https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ITimeScaleApi
- https://tradingview.github.io/lightweight-charts/docs/plugins/intro
- https://tradingview.github.io/lightweight-charts/docs/migrations/from-v4-to-v5
- https://tradingview.github.io/lightweight-charts/tutorials/react/simple
- https://raw.githubusercontent.com/tradingview/lightweight-charts/master/plugin-examples/src/plugins/trend-line/trend-line.ts
- https://api.github.com/repos/tradingview/lightweight-charts and /releases
- https://unpkg.com/lightweight-charts@5.2.1/package.json
- https://registry.npmjs.org/<package>/latest for: lightweight-charts, klinecharts, echarts, chartjs-chart-financial, react-financial-charts, uplot, highcharts, plotly.js, @amcharts/amcharts5, vite, react, react-router, @tanstack/react-router, @tanstack/react-query, tailwindcss, vite-plugin-pwa, vitest, typescript, zod, typescript-eslint, eslint, @biomejs/biome, @playwright/test, @vitejs/plugin-react, @supabase/supabase-js, luxon, date-fns, @date-fns/tz, happy-dom, jsdom, @testing-library/react
- https://raw.githubusercontent.com/klinecharts/KLineChart/main/README.md
- https://shop.highcharts.com/license
- https://www.amcharts.com/online-store/ ; https://www.amcharts.com/licenses/amcharts-20250624/
- https://www.anychart.com/buy/
- https://developers.cloudflare.com/workers/platform/limits/ ; /pages/platform/limits/ ; /workers/static-assets/billing-and-limitations/ ; /workers/static-assets/routing/single-page-application/ ; /workers/static-assets/headers/ ; /workers/static-assets/redirects/ ; /pages/
- https://www.cloudflare.com/terms/
- https://www.morphllm.com/comparisons/cloudflare-pages-vs-workers (third-party, via web search)
- https://vercel.com/docs/limits/fair-use-guidelines ; https://vercel.com/docs/plans/hobby
- https://www.netlify.com/pricing/ ; https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/ ; https://www.netlify.com/legal/terms-of-use/
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits ; https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://firebase.google.com/pricing ; https://render.com/docs/static-sites
- https://react.dev/learn/react-compiler/introduction
- https://ui.shadcn.com/docs/installation/vite
- https://vite-pwa-org.netlify.app/guide/inject-manifest.html
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/javascript/builtins/Temporal.json
- https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- Web searches (secondary): Temporal browser support; Vitest/Bun Windows issues (e.g. https://github.com/oven-sh/bun/issues/4145)
