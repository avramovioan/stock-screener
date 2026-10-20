# Free AI-model and web-search API tiers for a zero-cost daily company-research job

Research date / all "accessed" dates: **2026-10-15**.

**Method caveat.** WebFetch returns a *condensed* answer produced by a small model, not raw page text. Quotes below are what the tool returned in quotation marks; treat them as "as reported by WebFetch" until re-checked on the live page. Items marked **[UNVERIFIED]** come only from third-party blogs/search snippets or were not retrievable. Google does not publish a free-tier numeric table in its docs (limits are shown only inside AI Studio), so all Gemini free-tier RPM/RPD numbers are **[UNVERIFIED]** unless stated.

## 1. Executive recommendation

**OpenAI and Anthropic have no free API tier.** Their free plans are chat apps. OpenAI's API gives at most a one-off trial credit that expires, after which you must "purchase credits, currently a minimum $5" (help.openai.com via search snippet; openai.com/api/pricing returned 403). Anthropic's rate-limits page (fetched) lists only paid tiers (Start/Build/Scale with monthly spend caps $500/$1,000/$200,000) and no free tier or credit programme. Neither can be used at zero cost.

**Primary zero-cost stack (own retrieval + free LLM):**
- Retrieval: SEC EDGAR (10 req/s, User-Agent), company IR RSS, Yahoo Finance news (yahoo-finance2, other spike), direct page fetch from Edge Functions, Jina Reader (`r.jina.ai`, keyless 20 RPM / keyed 500 RPM) for PDF/HTML to text; web search spread across **Tavily (1,000 credits/mo, no card) + Exa (free credits) + Serper (2,500 one-off) + Jina `s.jina.ai` (key required, 100 RPM)**. Brave only if a card on file is acceptable (card required, overage uncapped).
- Synthesis: **Gemini API free tier, a Flash-Lite model, with structured JSON output, NO Google Search grounding, NO URL context**, so citations are only URLs we fetched ourselves and the grounded-results terms never apply.
- Fallbacks: Groq free (gpt-oss-120b / qwen3.8-27b) for tiny calls only (8K TPM cap), OpenRouter `:free` models (50 req/day unless a $10 lifetime top-up, which breaks "pay nothing"), Cloudflare Workers AI (10,000 neurons/day).

**Why not Gemini grounding:** free-tier grounding exists only on Gemini 2.5 Flash/Flash-Lite (500 RPD shared); on Gemini 3.x it is "Not available" on the free tier. Terms forbid caching grounded results and cap stored text at 2 years; we need indefinite storage and public display. Verdict: **not compatible** (section 4).

**Binding constraint:** search-call quota (about 3,300 searches/month worst case vs about 1,000/month per generous free provider), then Gemini's free daily request cap, which Google does not publish (forum: 20 RPD for Gemini 3.8 Flash, 500 RPD for Flash-Lite).

## 2. LLM free-tier table

| Provider | Model | RPM | RPD | TPM | Context | JSON schema | Tools / search | Data-use terms | Public-site OK? | Source |
|---|---|---|---|---|---|---|---|---|---|---|
| Google Gemini | 3.8 Flash | [UNVERIFIED] ~5 | **20** (forum, 2026-09-03) | unpublished | not stated (Argon: 1M) | Yes (OpenAI-compat doc) | Search grounding free: "Not available" | Free: "uses the content you submit ... to provide, improve, and develop Google products" | Gray, see s.4/7 | [P1][F2] |
| Google Gemini | 3.5 / 3.1 Flash-Lite | [UNVERIFIED] | **500** (forum mention "Flash-Lite's 500 RPD", generation not stated) | unpublished | not stated | Yes | Grounding free: "Not available" | same | Gray | [P1][F2] |
| Google Gemini | 2.5 Flash / Flash-Lite | [UNVERIFIED] | [UNVERIFIED] (older third-party 20-50) | unpublished | ~1M [UNVERIFIED] | Yes | Grounding free: "up to 500 RPD (limit shared with Flash-Lite RPD)"; 2.5 family "Limited access to active users only" | same | Gray | [P1][M1] |
| Google Gemini | 2.5 Pro | free tier reported removed April 2026 (third-party) [UNVERIFIED]; pricing page still says free | | | | | | | | [P1][M1] |
| Groq | openai/gpt-oss-120b, gpt-oss-20b | 30 | 1K | **8K** (TPD 200K) | 131,072 | Yes (browser search not compatible with structured outputs) | built-in browser search on gpt-oss models; free-plan availability not stated | not fetched [UNVERIFIED] | [UNVERIFIED] | [G1][G2][G3] |
| Groq | qwen/qwen3.8-27b | 30 | 1K | 8K (TPD 200K) | not stated | - | - | - | - | [G1] |
| Groq | llama-3.3-70b, 3.1-8b, groq/compound(-mini) | listed for shutdown 08/16/26 (llama) and 09/21/26 (compound): **past shutdown date** | | | | | | | | [G4] |
| OpenRouter | any `:free` model | 20 | **50** (<$10 lifetime credits); 1,000 (>= $10) | model-dependent | model-dependent | model-dependent | `:online` adds paid web search ("will incur extra costs, even with free models") | "Any prompt retention on OpenRouter is always opt-in"; provider policies vary | [UNVERIFIED] | [O1][O2][O4] |
| Cloudflare Workers AI | Llama 3.3 70B, Qwen3.8 27B, Gemma-4 26B, GLM-4.7-Flash (131k) | n/a | "10,000 Neurons per day at no charge", reset 00:00 UTC | - | model-dependent | [UNVERIFIED] | REST `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/...` usable outside Workers; OpenAI-compat endpoint not mentioned | [UNVERIFIED] | [UNVERIFIED] | [C1][C2][C3] |
| Mistral | Experiment plan | 1 req/s, 500k TPM, 1B tokens/mo (third-party) | - | - | - | - | - | third-party: may be used to train Mistral models; phone verification | [UNVERIFIED] | [MI1] (official help article 404) |
| Cerebras | gpt-oss-120b, qwen-3.8-27b | 5 | - | 30K uncached / 90K total; TPD 1M | - | - | - | "$5 in free credits" that "expire 30 days after they're granted": a trial, not a standing tier | - | [CE1] |
| GitHub Models | - | - | - | - | - | - | - | **Retired as of July 30, 2026** (docs.github.com) | - | [GH1] |
| Hugging Face Inference Providers | - | - | - | - | - | - | - | Free users: monthly credits "None"; PRO $2/mo | - | [HF1] |

Free-credit programmes (conditions): OpenAI one-off, expiring, one per phone (unverified); Cerebras $5/30 days; Exa $10; You.com $100 (unverified); Jina 10M tokens per new key. Renewable zero-cost quotas: Gemini, Groq, OpenRouter `:free`, Cloudflare, Tavily, Brave $5 credit (card), Firecrawl.

## 3. Search / retrieval API free-tier table

| Provider | Free quota | QPS / throughput | Caching / display terms | Source |
|---|---|---|---|---|
| Brave Search API | "$5 in free credits every month" (about 1,000 queries at $5/1k). Old Free 2,000/mo plan retired early 2026 (third-party). **Card required, overage billed, no default cap** (third-party) | 50 QPS (Search plan) | "If you would like to store the API results in part or whole (for example, to train or tune an LLM), you will need to subscribe to a plan that explicitly grants storage rights." Display of snippets on a site: clause not located [UNVERIFIED] | [B1][B2] |
| Tavily | "1,000 free API Credits every month. No credit card required." Basic search 1 credit, advanced 2; extract 1 credit per 5 URLs | not specified | ToS not reviewed [UNVERIFIED] | [T1] |
| Exa | "$10 in credits (up to 2,500 Instant searches)", described as resetting monthly (ambiguous: new accounts vs monthly) | not stated | not reviewed | [E1] |
| Serper.dev | "Get 2,500 free queries" (expiry not stated; assumed one-off) | not stated | not reviewed | [S1] |
| SerpApi | "250" searches/mo; "50" searches/hour | 50/h | commercial-use terms not on page [UNVERIFIED] | [SA1] |
| Jina Reader r.jina.ai | keyless "20 RPM"; keyed "500 RPM"; "Every new API key comes with 10M free tokens" | as stated | storage terms not reviewed | [J1] |
| Jina Search s.jina.ai | keyless "Not available (blocked)"; keyed "100 RPM" | 100 RPM | not reviewed | [J1] |
| Firecrawl | "1,000 credits / month", no card; scrape 1 credit/page; search 2 credits/10 results | 2 concurrent | not reviewed | [FC1] |
| You.com | $100 signup credit / 100 queries/day per third-party aggregators [UNVERIFIED] | - | - | [Y1] |
| Google Programmable Search JSON API | "100 search queries per day for free" but **"closed to new customers"**; existing customers must transition by **January 1, 2027** | - | - | [GC1] |
| Bing Web Search API | **Retired August 11, 2025**; replacement Grounding with Bing (Azure AI Agents, about $35/1k, no raw results) | - | - | [BG1] |
| DuckDuckGo | No official search API (from knowledge; not verified this session) | - | - | - |
| OpenRouter web plugin | Not free: Exa $0.007/request, Perplexity $0.005, Parallel $0.001-0.005 | - | - | [O4] |
| SEC EDGAR | Free; "Current max request rate: 10 requests/second"; must declare a `User-Agent` such as `Sample Company Name AdminContact@<domain>.com`; submissions/XBRL JSON on data.sec.gov. Full-text-search endpoint not confirmed on fetched page [UNVERIFIED] | 10 req/s | public data; SEC may throttle | [SEC1] |
| Google News RSS | no key. Third-party summary: feeds "designed for non-commercial use"; republishers must attribute Google News and each provider and link to the cluster. Official terms not fetched [UNVERIFIED] | no cap documented | attribution required | [GN1] |
| Yahoo Finance (yahoo-finance2 `search()`) | unofficial; covered by another spike | - | unofficial, ToS risk | - |

Only Brave is confirmed to restrict storage; others are unreviewed.

## 4. Gemini grounding terms analysis

Source: https://ai.google.dev/gemini-api/terms (condensed by WebFetch, accessed 2026-10-15).

- Display: "You will only display the Grounded Results with the associated Search Suggestion(s) to the end user who submitted the prompt."
- Core restriction: "You will not, and will not allow your end user or any third party to, cache, frame, syndicate, resell, analyze, train on, or otherwise learn from Grounded Results" except as expressly permitted.
- Permitted storage (as reported): "for up to two (2) years, the text of the Grounded Result(s)" for evaluation; end-user chat history; temporary resubmission.
- Google-side retention: "thirty (30) days for the purposes of creating Grounded Results and Search Suggestions" (the "up to 30 days" figure is Google's retention of prompts/outputs; the 2-year figure is the customer storage cap). Two fetches phrased the 30-day purpose differently (debugging vs creating results); re-check live page.
- Free-tier data use: "Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products and services." and "Do not submit sensitive, confidential, or personal information to the Unpaid Services."
- Audience/purpose: "Use of Google AI Studio and Gemini API is for developers building with Google AI models for professional or business purposes, not for consumer use." Also no use in a service "directed towards or is likely to be accessed by individuals under the age of 18."
- EEA/CH/UK: paid-service data terms apply "to all Services, including Google AI Studio and unpaid quota in the Gemini API".
- Free-tier grounding availability (pricing page): Gemini 3.x free "Not available"; 2.5 Flash free "up to 500 RPD (limit shared with Flash-Lite RPD)". Paid 3.x: "5,000 free search requests per month (shared across all Gemini 3 and newer models), then $14 per 1,000 requests".
- URL context: up to 20 URLs/request, 34MB per URL, PDF supported, charged as input tokens; free-tier availability per model not stated on fetched pages.

**Verdict.** Grounded Results cannot be cached or syndicated, text storage is capped at 2 years, and display must pair with Search Suggestions to the prompting user only. A public site showing stored reports to all visitors, retained indefinitely, conflicts with these. Do not store or republish grounded outputs; use Gemini only as a text synthesizer over our own fetched sources. Open point: whether a private individual's public site counts as "professional or business purposes, not for consumer use".

## 5. Consumption estimate (worst case: 5 reports + 40 checks per day, 30 days)

| Item | Daily | Monthly |
|---|---|---|
| Report searches (5 x 10) | 50 | 1,500 |
| Check searches (40 x 1.5) | 60 | 1,800 |
| **Total searches** | **~110** | **~3,300** (typical 2 reports + 20 checks: ~50 / ~1,500) |
| Page fetches (5 x ~5) | 25 | 750 |
| Input tokens (5 x 80k + 40 x 10k) | ~800k | ~24M |
| Output tokens (5 x 2.5k + 40 x 0.5k) | ~32k | ~1M |
| LLM calls (reports chunked ~3 each + 40 checks) | ~55 | ~1,650 |

Against quotas:
- **Search**: one free provider covers only about 1,000/month (Brave $5 credit, Tavily, Firecrawl). Tavily 1,000 + Exa up to 2,500 + Serper 2,500 (one-off) + Jina `s.` cover the worst case for a few months; sustained supply is about Tavily 1,000 + Brave 1,000 (+ Exa if monthly), so this is the binding constraint. Cut demand: checks use RSS/EDGAR/Yahoo/Google News first (zero search credits) and search only on a hit; reports cap at about 5-6 searches via query planning. Target at most 1,000/month per provider.
- **Gemini Flash-Lite**: 55 calls/day fits a 500 RPD cap [UNVERIFIED]; 3.8 Flash at 20 RPD does not. TPM unpublished, so chunk report calls to about 30k tokens.
- **Groq**: 8K TPM and 200K TPD. A 10k-token check already exceeds TPM; 80k reports impossible. Only tiny classify calls (under 6k tokens).
- **Cerebras free**: 30-day $5 trial, not sustainable.
- **OpenRouter `:free`**: 50 req/day covers checks only.
- **Cloudflare**: 10,000 neurons/day; neurons per token unverified; likely at most 1-2 reports.

## 6. Proposed pipeline (Deno Edge Functions, 150 s wall clock) and degradation rules

Queue table `research_jobs(status, step, payload, attempts, not_before)`; pg_cron invokes a worker every few minutes; each invocation runs ONE step and stays under about 100 s.
1. `plan` (small LLM call): queries and sources to hit (EDGAR, IR RSS, news). 5-10 s.
2. `search` (1-3 calls per invocation): Tavily/Exa/Serper with provider rotation and per-provider monthly counters in DB; store URL/title only.
3. `fetch` (at most 3 pages per invocation, 15 s timeout each): direct fetch, fallback `r.jina.ai` for PDF/odd HTML; respect robots/ToS.
4. `extract` (LLM per document chunk of at most 30k tokens, JSON schema): facts with source URL and quote span.
5. `synthesize` (LLM, at most 20k input): final report JSON, 2-3k output.
6. `publish`: validate every citation URL is in the fetched set; write to DB.
Material change checks: diff RSS/EDGAR/Yahoo first; if nothing new, no LLM and no search; else 1 search + 1 small LLM call.

Degradation rules: (a) per-provider counters in DB; on 429 or counter at or above 90%, switch provider, then pause. (b) LLM quota exhausted: set `not_before` to the next daily reset (Gemini reset time unverified; use next 00:00 UTC conservatively plus one retry), keep status queued; prioritize reports over checks only while at least 25% of the daily LLM budget remains. (c) Max 5 reports/day, extras queued FIFO to the next day. (d) Search quota exhausted: run report on EDGAR/IR/Yahoo/Google News only and flag "limited sources". (e) Never enable billing on any account; send only public identifiers and public page text (free Gemini data is used for product improvement).

## 7. Open questions / unverified

- Exact Gemini free-tier RPM/TPM/RPD per model (only in AI Studio); 20 RPD (3.8 Flash) and 500 RPD (Flash-Lite) are forum-sourced.
- Whether a free-tier Gemini key may power a private individual's public website ("professional or business purposes, not for consumer use"); EEA/UK users get paid-tier data terms on free quota.
- Whether Gemini 2.5 remains available ("Limited access to active users only").
- Brave: exact display/storage clauses; whether a card is mandatory (third-party says yes).
- Tavily/Exa/Serper/Jina/Firecrawl/SerpApi caching and display terms; Exa credit reset cadence; Serper expiry; You.com official free tier.
- Mistral Experiment plan official limits/terms (help page 404).
- Groq data-use terms; whether browser search is free.
- Cloudflare neurons per request, structured output, OpenAI-compat endpoint.
- OpenRouter current `:free` model list and per-model data policy.
- Google News RSS official terms; EDGAR full-text-search endpoint; DuckDuckGo having no API (not fetched).
- OpenAI official free-credit statement (pricing page 403).

## 8. Provider abstraction (OpenAI-compatible chat completions)

- Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/` (beta; unsupported params silently ignored; structured outputs and function calling supported) [F3].
- Groq: `https://api.groq.com/openai/v1` (seen in models docs) [G2].
- Hugging Face router: `https://router.huggingface.co/v1` [HF1].
- OpenRouter (`https://openrouter.ai/api/v1`), Mistral, Cerebras: OpenAI-style chat completions [UNVERIFIED this session].
- Cloudflare Workers AI: native REST (`/ai/run/...`); OpenAI-compat not confirmed [C3].
One adapter: base URL, key, model, JSON-schema toggle, per-provider limits table.

## 9. Sources (all accessed 2026-10-15)

- [P1] https://ai.google.dev/gemini-api/docs/pricing
- [F1] https://ai.google.dev/gemini-api/docs/rate-limits (no per-model free table; "View your active rate limits in AI Studio")
- [F2] https://discuss.ai.google.dev/t/gemini-3-8-flash-free-tier-20-rpd-is-too-limited-for-practical-evaluation/180609
- [F3] https://ai.google.dev/gemini-api/docs/openai ; terms https://ai.google.dev/gemini-api/terms ; grounding https://ai.google.dev/gemini-api/docs/google-search ; URL context https://ai.google.dev/gemini-api/docs/url-context ; models https://ai.google.dev/gemini-api/docs/models
- [M1] third-party, May 2026: https://tinkerllm.com/blog/gemini-api-free-tier-limits-rate-quotas/ (unverified numbers)
- [G1] https://console.groq.com/docs/rate-limits ; [G2] https://console.groq.com/docs/models ; [G3] https://console.groq.com/docs/browser-search ; [G4] https://console.groq.com/docs/compound (deprecations content)
- [O1] https://openrouter.ai/docs/api-reference/limits ; [O2] https://openrouter.ai/docs/guides/privacy/data-collection ; [O4] https://openrouter.ai/docs/guides/features/plugins/web-search
- [C1] https://developers.cloudflare.com/workers-ai/platform/pricing/ ; [C2] https://developers.cloudflare.com/workers-ai/models/ ; [C3] https://developers.cloudflare.com/workers-ai/get-started/rest-api/
- [MI1] search snippets (cheahjs/free-llm-api-resources mirror); [CE1] https://inference-docs.cerebras.ai/support/rate-limits ; [GH1] https://docs.github.com/en/github-models/prototyping-with-ai-models ; [HF1] https://huggingface.co/docs/inference-providers/pricing
- Anthropic https://platform.claude.com/docs/en/api/rate-limits ; OpenAI https://help.openai.com/en/articles/8264644 (search snippet)
- [B1] https://brave.com/search/api/ ; [B2] third-party summaries via search (costbench.com, agentdeals.dev)
- [T1] https://docs.tavily.com/documentation/api-credits ; [E1] https://exa.ai/pricing ; [S1] https://serper.dev ; [SA1] https://serpapi.com/pricing ; [J1] https://jina.ai/reader/ ; [FC1] https://www.firecrawl.dev/pricing ; [Y1] https://costbench.com/software/ai-search-apis/you-com-api/ (search snippet) ; [GC1] https://developers.google.com/custom-search/v1/overview ; [BG1] https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- [SEC1] https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data ; [GN1] search snippet (https://www.codewords.ai/blog/google-news-rss)
