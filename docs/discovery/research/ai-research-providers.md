# AI research providers for source-backed fundamental company research

Research date / cutoff: **2026-10-15** (all "accessed" dates below are 2026-10-15 unless stated).
Scope: provider comparison, cost worksheet, pipeline design, free primary-source filing APIs. No code written.
Evidence convention: **[V]** verified in an official doc fetched today; **[S]** from a summarising fetch or secondary source, re-check before relying; **[U]** unverified.

---

## 1. Executive recommendation

**Primary: Anthropic Claude API, `claude-sonnet-5-5`, server-side `web_search` + `web_fetch`, run through the Message Batches API from a cron tick (poll on later ticks).**
**Cheap change check: `claude-haiku-5-5` (released 2026-10-07) with `web_search` only; fallback `claude-haiku-4-5`.** Confirm web-search support for Haiku 5.5 via the Models API (`capabilities.server_tools.web_search.supported`) before committing [U for Haiku 5.5].
**Fallback provider: OpenAI Responses API (`web_search` tool, background mode, Batch).** Perplexity Sonar is a supplementary "find recent news" source only. **Do not use Gemini grounding for stored/published output** (terms forbid caching and analysing grounded results, see 5.2).

Why Claude first:
1. Citation objects carry `url`, `title`, `cited_text` (<=150 chars) and `encrypted_index`; search results carry `page_age`; fetch results carry `retrieved_at` [V]. This maps directly onto "accept only URLs that came back from a tool result".
2. `web_fetch` reads PDFs and HTML at **no extra charge** beyond tokens; it can only fetch URLs already present in the conversation (anti-fabrication by design) [V].
3. Batch API works with all server tools at 50% off tokens; most batches finish < 1 h, hard limit 24 h [V]. This removes the Edge Function wall-clock problem.
4. `npm:@anthropic-ai/sdk` officially supports Deno >= 1.28 [V].
5. Prices are low (Sonnet 5.5 $2/$10 per MTok) and the web search fee ($10 per 1,000 searches) is the same across Claude models, so it is the cost floor.

Key risks (details in section 6): (a) real annual-report PDFs/HTML can be 100-300k+ tokens each, far above the 60-100k input assumption, so pre-extract filings ourselves from EDGAR where possible; (b) sync wall-clock for 10+ search runs is **not documented** by Anthropic and must be measured; (c) Anthropic's updated Usage Policy has high-risk finance rules (human review / AI disclosure) needing a legal read; (d) Start-tier monthly spend cap is $500.

---

## 2. Comparison table

| Provider / model | Web search | Page/PDF fetch | Citation quality (URL+title+date?) | Structured output | Async / batch | Deno fit | Est. cost / full report | Est. cost / change check | Rate limits |
|---|---|---|---|---|---|---|---|---|---|
| **Claude Sonnet 5.5** `claude-sonnet-5-5` | `web_search_20260318/20260209/20250305`; `max_uses`, allow/block domains, `user_location` [V] | `web_fetch_*`, HTML + PDF, no extra fee; URL must already be in context [V] | url + title + cited_text (<=150 chars) + `page_age` (site last-updated, NOT publication date) + fetch `retrieved_at` [V] | `output_config.format` json_schema GA [V]; combination with server-tool citations unverified | Batches: 50% off, <24 h, results kept 29 d; server tools supported [V]; `pause_turn` for long turns [V] | Official SDK supports Deno [V] | ~$0.31 (range $0.22-$0.38) | ~$0.05 | Start tier: 1,000 RPM / 2M ITPM / 400k OTPM; $500/mo spend cap [V] |
| **Claude Haiku 5.5** `claude-haiku-5-5` | presumed same tool family; **not verified** | same | same | GA [V] | same | same | ~$0.13 | ~$0.02 | Start tier same as Sonnet 5.5 [V] |
| **Claude Haiku 4.5** `claude-haiku-4-5` | basic web search (verify); dynamic filtering needs `allowed_callers:["direct"]` on models without programmatic tool calling [V rule, U for this model] | same | same | GA (4.x) | same | same | ~$0.21 | ~$0.035 | same tier |
| **OpenAI Responses** `gpt-6.1-sol` [S] | `web_search`, "$10.00 / 1k calls"; up to 100 allowed/blocked domains; `user_location`; `search_context_size` low/medium/high [S] | `open_page`/`find_in_page` actions for reasoning models [S]; PDF behaviour unverified | `url_citation` annotations: url, title, start_index, end_index (no date) [S] | Responses structured outputs (not re-verified here) | `background=true` + polling, data stored ~10 min; Batch API 50% [S] | REST via `fetch`; first-party Deno SDK not verified | ~$0.31 (gpt-6.1-sol), ~$0.19 (gpt-5.4-mini) | ~$0.04-0.05 | "same tiered rate limits for underlying model" [S] |
| **Perplexity Sonar / Sonar Pro** | built in; per-request fee by context size; `search_domain_filter` max 20; recency filter [S] | no general PDF-reading tool verified | `citations`/`search_results` with url, title, date [S] | `response_format` json_schema; first request with a new schema +10-30 s [S] | Old async Sonar endpoint no longer supported; Agent API background mode (`POST /v1/agent`, poll `GET /v1/agent/{id}`) [S] | plain REST | not modelled (too shallow for filings); sonar-pro single request ~$0.10-0.15 | ~$0.01-0.02 (sonar) | Agent API: Tier 0 1 QPS, Tier 1 3 QPS ($50+) [S] |
| **Gemini** (Flash/Pro + Google Search grounding + URL context) | `google_search`; $14 / 1k search requests after 5,000 free/month (Gemini 3+); 2.5 models: 1,500 RPD free then $35 / 1k grounded prompts [S] | URL context: HTML, PDF, images; 20 URLs/request, 34 MB/URL; paywalls unsupported [S] | `url_citation` annotations with start/end index; **terms bar caching/analysing grounded results** [S] | Tools + structured output = preview, Gemini 3 series only [S] | Batch 50% [S] | REST | ~$0.24 (Gemini 3.8 Flash) | ~$0.03 | view in AI Studio only [S] |

Notes: costs for non-Claude rows are rough (section 3.4). "[S]" prices came through a summarising fetch and model names (gpt-6.1-sol, Gemini 3.8 Flash) look new, so re-verify on the pricing pages before any budget sign-off.

---

## 3. Cost worksheet

### 3.1 Verified unit prices (Anthropic) [V]
Source: https://platform.claude.com/docs/en/about-claude/pricing (accessed 2026-10-15)

| Model | Input | Output | 5m cache write | 1h cache write | Cache read | Batch in / out |
|---|---|---|---|---|---|---|
| Claude Sonnet 5.5 | $2 / MTok | $10 / MTok | $2.50 | $4 | $0.10 (0.05x) | $1 / $5 |
| Claude Opus 5.5 | $4 / MTok | $20 / MTok | $5 | $8 | $0.20 | not extracted |
| Claude Haiku 5.5 (prompt <=100k tokens) | $0.10 / MTok | $0.50 / MTok | $0.125 | $0.20 | $0.01 | $0.05 / $0.25 |
| Claude Haiku 5.5 (prompt >100k tokens) | $0.50 / MTok | $2.50 / MTok | $0.625 | $1 | $0.05 | $0.25 / $1.25 |
| Claude Haiku 4.5 | $1 / MTok | $5 / MTok | $1.25 | $2 | $0.10 | $0.50 / $2.50 |

- Web search: "Web search is available on the Claude API for **$10 per 1,000 searches**, plus standard token costs for search-generated content." Errors are not billed. Batch web search is "priced the same as" synchronous [V].
- Web fetch: "no additional charges beyond standard token costs" [V]. Code execution used by dynamic filtering: no extra charge [V].
- Model IDs: `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5` are current; `claude-haiku-4-5` is a legacy-but-available model [V] (https://platform.claude.com/docs/en/models/overview).
- Haiku 5.5 uses the newer tokenizer (~30% more tokens than Haiku 4.5 for the same text) and is priced by prompt length, threshold 100,000 tokens including cache reads [V].
- Min cacheable prompt: 512 tokens (Sonnet 5.5, Opus 5.5, Haiku 5.5), 4,096 (Haiku 4.5) [V]. Cache TTL 5 min default, 1 h at 2x write [V]. When any `cache_control` exists, server-tool results get an automatic 5-minute breakpoint [V].
- Effort default: Sonnet 5.5 `high`, Haiku 5.5 `medium`, Opus 5.5 `medium` [V]. Adaptive thinking adds output tokens (not modelled; set `effort` explicitly and measure).

### 3.2 Assumptions (from brief)
Full report: 8 / 12 / 15 searches (low/mid/high), 3-6 fetches (free), input 60k / 80k / 100k tokens (all treated as uncached = conservative), output 2k / 2.5k / 3k.
Change check: 1 / 2 / 3 searches, 10k input, 1k output (output not given in brief; I assumed 1k).

### 3.3 Anthropic results (synchronous, no cache savings, no thinking overhead)

| Case | In | Out | Searches | Sonnet 5.5 | Haiku 5.5 | Haiku 4.5 |
|---|---|---|---|---|---|---|
| Report low | 60k | 2k | 8 | 0.12+0.02+0.08 = **$0.22** | 0.006+0.001+0.08 = **$0.087** | 0.06+0.01+0.08 = **$0.15** |
| Report mid | 80k | 2.5k | 12 | 0.16+0.025+0.12 = **$0.305** | 0.008+0.00125+0.12 = **$0.129** | 0.08+0.0125+0.12 = **$0.2125** |
| Report high | 100k | 3k | 15 | 0.20+0.03+0.15 = **$0.38** | 0.01+0.0015+0.15 = **$0.1615** | 0.10+0.015+0.15 = **$0.265** |
| Change check (2 searches) | 10k | 1k | 2 | 0.02+0.01+0.02 = **$0.05** (0.04-0.06) | 0.001+0.0005+0.02 = **$0.0215** (0.0115-0.0315) | 0.01+0.005+0.02 = **$0.035** (0.025-0.045) |

- Batch API: tokens halve, search fee unchanged. Sonnet 5.5 mid report = (0.16+0.025)/2 + 0.12 = **~$0.21**.
- Searches are 39-93% of cost depending on model (about 93% with Haiku 5.5). Cutting `max_uses` is the biggest lever; Sonnet vs Haiku matters mainly for token-heavy filing reading.
- **Input-token sensitivity (important):** fetch docs give "Average web page (10 kB): ~2,500 tokens; Large documentation page (100 kB): ~25,000 tokens; Research paper PDF (500 kB): ~125,000 tokens" [V]. `max_content_tokens` does not limit PDFs [V]. A full 10-K/annual report (HTML or PDF) is plausibly 100-300k+ tokens (estimate, not measured); one such read plus searches could reach ~250k input = Sonnet 5.5 about $0.50 + $0.025 + $0.12 = **~$0.65**. Haiku 5.5 would cross its 100k threshold and reprice to $0.50/$2.50. Mitigation: section extraction in our own code (section 4) or dynamic filtering (`web_fetch_20260209+`).
- Agentic loop re-reads: each iteration re-sends the growing prefix; with automatic server-tool-result caching the re-reads bill at cache-read rates (Sonnet 5.5 $0.10/MTok), so real input is better modelled as cache write plus reads than 80k fresh tokens. Measure `usage` per request; not modelled.
- Volume: 30 reports/day x $0.305 = ~$9.2/day (~$275 per 30 days); with Haiku 5.5, 30 x $0.129 = ~$3.9/day. 50 Sonnet change checks/day = $2.5/day. Start-tier cap is **$500/month** [V], so all-Sonnet at top volume plus checks is near the cap.

### 3.4 Other providers (rough; same assumptions: 80k in, 2.5k out, 12 searches)
- OpenAI `gpt-6.1-sol` [S]: 0.16 + 0.025 + 12 x $0.01 = ~**$0.305**; `gpt-5.4-mini` ($0.75/$4.50) = 0.06 + 0.011 + 0.12 = ~**$0.19**. Search content tokens are "billed at model rates" [S].
- Gemini 3.8 Flash [S] ($0.75/$3.75): 0.06 + 0.009 + 12 x $0.014 = ~**$0.24** (5,000 free search requests/month would cover ~400 reports at 12 queries each).
- Perplexity [S]: sonar $1/$1 + $5/$8/$12 per 1k requests (low/med/high context); sonar-pro $3/$15 + $6/$10/$14; sonar-reasoning-pro $2/$8 + $6/$10/$14; sonar-deep-research $2/$8 + citation $2/1M, reasoning $3/1M, $5/1k search queries. Single requests are cheap but do not read filings in depth.

---

## 4. Proposed prompt / pipeline architecture

### 4.1 Principles
1. **Our code owns the evidence ledger.** The LLM never emits a URL we have not already recorded from a tool result.
2. **Two stages**: Stage 1 evidence gathering (tools on, no structured-output constraint). Stage 2 report generation (no tools, `output_config.format` JSON schema, evidence supplied as numbered text blocks). Stage 2 cites by `evidence_id`, never by URL; our code renders URL/title/date from the ledger.
3. **Deterministic data first**: pull filing lists, filing dates and XBRL numbers from SEC EDGAR (free) before calling the LLM; give the model compact extracted sections rather than making it read 300-page PDFs. Hand EDGAR URLs to Claude in the user message (that is what makes them fetchable under the URL-in-context rule [V]).

### 4.2 Stage 0: deterministic prefetch (Edge Function, no LLM)
- Resolve ticker to CIK; `data.sec.gov/submissions/CIK##########.json` for the latest 10-K/10-Q/8-K list and filing dates; `companyfacts` for key metrics. Respect fair-access (section 5).
- Fetch the primary filing HTML, split into sections (Item 1A, 7, 8 + notes), store text in Postgres; tag each chunk with an evidence ID and the SEC URL.
- Non-US: use the table in 5.1; otherwise let Claude `web_fetch` the IR/OAM PDF.

### 4.3 Stage 1: evidence gathering (Claude + server tools)
- Model `claude-sonnet-5-5`; tools: `web_search_20260209` (or `_20260318`) with `max_uses` ~8-10; `web_fetch_*` with `max_uses` ~4, `citations:{enabled:true}`, `max_content_tokens` for HTML. Set `allowed_callers:["direct"]` if you want ZDR-eligible behaviour or the model lacks programmatic tool calling [V].
- Do not combine with `output_config.format` here (documented incompatibility is for citations on user-provided documents; interplay with server-tool citations is unverified).
- Fixed prompt prefix (>= 512 tokens, `cache_control` on the system block): role, research cutoff date, source hierarchy (primary filings > company releases > credible press), instruction to separate fact / management claim / forecast / allegation / interpretation, instruction to write notes with short quotations and never to type a URL in prose.
- Harness builds the **ledger** from response blocks: `web_search_tool_result.content[].{url,title,page_age}`, `web_fetch_tool_result.content.{url,retrieved_at,content.title}`, and every `citations[]` entry (`url`, `title`, `cited_text`; `char_location`/`page_location` for fetched docs). Ledger row: evidence_id, canonical URL, title, source kind, page_age or filing date, retrieved_at, cited_text, hash of fetched text.
- `pause_turn`: re-send assistant content unchanged with the same tools; keep `encrypted_content` intact or the next request 400s [V].
- Server-tool errors return HTTP 200 with an error object in `content` (list vs object) [V]; treat as soft failures.

### 4.4 Stage 2: report generation (Claude, no tools)
- Input: ledger entries as numbered text blocks (id, title, date, kind, snippets) + Stage 0 numbers. Constrain with `output_config.format` (supported on Sonnet 5.5, Opus 5.5, Haiku 5.5 [V]; schema limits: no recursion, no numeric min/max, no string length limits, `additionalProperties:false` only [V]).
- Schema fields: `research_cutoff_date`, `sections[]` (claims with `claim_text`, `claim_type` enum {established_fact, management_claim, forecast, allegation, interpretation}, `evidence_ids[]`), `conclusion` enum of the three exact strings, `bankruptcy_risk` enum {Low, Moderate, High, Unclear}, `material_lasting_damage_established` bool, `sufficient_evidence_available` bool, `limitations[]`.
- Code-level rules: every established fact needs >=1 `evidence_id`; unknown ids -> reject and retry once; "Meets" requires both flags true, else force "Insufficient evidence to decide"; 500-800 word limit enforced in code (length constraints are not schema-enforceable [V]).
- The sources list is **rendered by our code** from ledger rows (title, URL, publication/filing date, retrieved_at), never from model text.

### 4.5 URL verification policy
1. Accept a URL only if its normalised form (lowercase host, strip fragment/tracking params) exists in this run's ledger.
2. Reject any URL appearing in model prose that is not in the ledger.
3. Liveness check from our own Edge Function: GET (HEAD is often blocked), 5-8 s timeout, require 2xx; SEC hosts with the declared User-Agent; store status, content-type, content hash, `verified_at`.
4. For fetched docs, fuzzy-match `cited_text` against our stored text to confirm the quote exists (web-search `cited_text` is <=150 chars and not billed [V]).
5. Date discipline: `page_age` is "when the site was last updated" [V], not publication date; use EDGAR `filingDate` for filings and label other dates "page age (approx)".
6. Fail closed: a report with an unverified URL is marked "needs review", not published.

### 4.6 Fitting the wall-clock limit
Supabase Edge Functions: wall clock "Free plan: 150s, Paid plans: 400s", request idle timeout 150 s, max CPU 2 s, memory 256 MB [V: https://supabase.com/docs/guides/functions/limits].
- **Daily reports -> Batch API (recommended).** Tick A (cron): Stage 0, create one batch with N Stage-1 requests (`custom_id` = company+date), store `batch_id`. Later ticks (every 5-10 min): `retrieve(batch_id).processing_status`; at `ended`, stream `results_url` JSONL keyed by `custom_id` (results come back unordered [V]), build ledgers, handle `pause_turn` results via a continuation batch (batch has a higher per-turn iteration limit [V]), then run Stage 2 (one no-tool request, ~2-3k output; expected well inside 150 s but not measured) or a second batch. Limits: 100,000 requests or 256 MB per batch, expires after 24 h, results kept 29 days [V]; web search in batches is throttled per organisation so large batches can be slower [V].
- **Ad hoc / interactive**: split into steps each <= ~100 s: one Messages call with `max_uses` 3-4 using `stream()` + `finalMessage()` (avoids idle-connection timeouts), persist full assistant `content` JSON in Postgres, return; next invocation continues (`pause_turn` or follow-up user turn). Keep steps idempotent via a `run_id`/`step` table.
- **Change check** (1-3 searches, ~10k tokens): probably feasible synchronously in one invocation (expected tens of seconds, **unmeasured**); use a 120 s `AbortController` and fall back to enqueueing a batch item.
- Anthropic publishes no typical latency for a 10-search request. The SDKs validate that non-streaming requests are not expected to exceed ~10 minutes and recommend streaming or Batches for long requests [V: errors and TypeScript SDK pages]. **Verdict: do not rely on one synchronous call for a full report inside 150-400 s; use Batch for reports and short sync steps for change checks; benchmark before deciding on sync for ad hoc.**
- Cost controls: cache the static system prompt (`cache_control`, 1 h TTL; batch cache hits are best-effort [V]), set `max_uses`, cap `max_tokens`, set `effort` explicitly, log `usage` incl. `server_tool_use.web_search_requests`.
- Model gotchas [V, api/errors page]: no assistant prefill; forced `tool_choice` any/tool returns 400 on Sonnet 5.5/Opus 5.5; `thinking:{type:"disabled"}` returns 400 on Sonnet 5.5 (use `between_tools` or leave adaptive; Haiku 5.5 accepts disabled but with effort limits).

---

## 5. Primary-source APIs and provider terms

### 5.1 Free filing / primary-source APIs

| Source | Endpoint | Auth | Rate limit | Coverage / notes | Callable from Deno with no account? |
|---|---|---|---|---|---|
| SEC EDGAR submissions | `https://data.sec.gov/submissions/CIK##########.json` | none; **User-Agent with company/contact required** | max 10 requests/second [V] | filing index per company; updates < 1 s after dissemination [V] | Yes, send UA header |
| SEC XBRL | `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`, `/companyconcept/...`, `/frames/...` | none | same 10 rps | XBRL facts, ~1 min lag [V]; no CORS (irrelevant server-side) | Yes |
| SEC full-text search | `efts.sec.gov/LATEST/search-index?q=...` (web UI backend) | none apparent | same fair-access | FAQ: indexes filings "since 2001"; **no documented programmatic API**, FAQ directs to textsearch@sec.gov [V]; endpoint behaviour [U] | Probably, unsupported; use sparingly |
| SEC archives (filing HTML/PDF) | `https://www.sec.gov/Archives/edgar/data/<CIK>/<acc>/...` | none + UA | 10 rps; policy: no botnets / automated tools outside acceptable policy [V] | primary filings | Yes, respect policy |
| UK Companies House | `https://api.company-information.service.gov.uk/...` | **API key** (register an application; HTTP Basic, key as username, blank password) [V] | 600 requests / 5 minutes [V] | filing history, profile; accounts-document access not verified [U] | Needs registered key (cost not stated in fetched doc) |
| UK FCA National Storage Mechanism | data.fca.org.uk NSM search UI | n/a | n/a | UK regulated announcements and annual reports; **no official API verified** (only third-party scrapers found) [U] | Not as a supported API |
| EU ESEF (XBRL International index) | `https://filings.xbrl.org/api/filings?...` (JSON:API) | none apparent | not stated | ESEF/other iXBRL filings with report/viewer/json URLs (26,009 filings seen) [S] | Yes; community index, coverage/SLA unverified |
| EU ESAP (official) | n/a yet | n/a | n/a | ESMA data collection began 2026-07-10; public go-live expected by July 2027; full by Jan 2030 [S] | Not usable now |
| Japan EDINET API v2 | `https://api.edinet-fsa.go.jp/api/v2/documents.json?date=YYYY-MM-DD&type=2&Subscription-Key=...` | **Subscription-Key required** (registration terms not read) [S] | not verified | JP securities/quarterly reports; spec updated 2026-06-03 [S] | Needs key |
| Canada SEDAR+ | web UI only | public search, no account | n/a | **no official public API**; third parties use browser automation [S] | No |
| Company IR RSS | per company | none | n/a | not researched [U] | Yes, per-site |

SEC User-Agent format from the policy: `User-Agent: Sample Company Name AdminContact@<sample company domain>.com` [V]. Route all SEC calls through one throttled queue (<=10 rps project-wide; Edge Functions are stateless, so use a DB-backed token bucket). Whether SEC throttles shared Supabase egress IPs is unknown [U].

### 5.2 Provider terms / data retention
- **Anthropic usage policy**: the fetched page (via summarising tool) shows effective date **2026-11-12**, i.e. a future version relative to today [S]. It says a "High-risk AI Recommendation" (personalised recommendation to buy, sell, hold or allocate among specific investment products, or personal tax advice) needs meaningful review by "a qualified person ... before it is delivered", and the recipient must be clearly told AI was used; consumer-facing chatbots must disclose AI [S]. Generic company-risk research is likely outside "personalised", but our "Meets these two fundamental checks" conclusion on a user's holding is a grey zone: **legal review and disclaimers needed** (not legal advice). Web search docs: "When displaying API outputs directly to end users, citations must be included to the original source. If you are making modifications ... display citations as appropriate based on consultation with your legal team." [V]
- **Anthropic retention**: the retention page says retained data is never used for model training without express permission and conversation content is not retained by default except Covered Models (30-day) [V, written in a ZDR context; the standard commercial retention policy page was **not** fetched, so default retention is [U]]. Batch: 29-day retention, not ZDR-eligible [V]. Basic web search/fetch are ZDR-eligible; `_20260209+` dynamic filtering is not unless `allowed_callers:["direct"]` [V]. We send only public company identifiers, so ZDR is optional.
- **Gemini**: grounded results may only be displayed with Search Suggestions to the end user who submitted the prompt, and users may not "cache, frame, syndicate, resell, analyze, train on, or otherwise learn from Grounded Results", with narrow exceptions; Google stores prompts/outputs 30 days for grounding; free-tier content is used to improve Google products; "Don't rely on the Services for medical, mental health, legal, financial, or other professional advice" [S: https://ai.google.dev/gemini-api/terms]. This conflicts with persisting and publishing reports on a website, so **exclude Gemini grounding from the design**.
- **OpenAI**: background mode stores response data ~10 minutes; ZDR projects run with `store=false` [S]. The usage-policies page returned 403, so financial-use terms are **unverified**.
- **Perplexity**: output-use terms not reviewed [U].

---

## 6. Open questions and unverified items

1. **Sync wall-clock** for a 10-search agentic Claude request: no official figure; benchmark with real prompts (p50/p95) before choosing sync vs batch for ad hoc runs.
2. **Haiku 5.5 web search/fetch support and dynamic filtering** not confirmed; query Models API `capabilities.server_tools`. Haiku 4.5 support for the newest tool versions not re-verified.
3. **Web search + structured outputs** in one request: only the user-document-citation incompatibility is documented; test it, though the two-stage design avoids needing it.
4. **Evaluation-tier limits**: new organisations "may start in the Evaluation tier, with limits below the standard limits" [V]; actual RPM/ITPM and the web-search rate limit are visible only in the Console. The Start-tier figures quoted are standard ones.
5. **Real input size** of annual reports/PDFs (the 60-100k assumption is likely low) and PDF token cost per page: measure with `count_tokens` on ~5 sample filings.
6. **Cache economics** of the agentic loop and of batches (best-effort) not measured.
7. **OpenAI**: prices and model names came from a summarising fetch (gpt-6-astra $10/$50; gpt-6.1-sol $2/$10; gpt-5.4-mini $0.75/$4.50; gpt-5.4-nano $0.20/$1.25; web search $10.00/1k calls); re-verify, plus Batch + web_search compatibility, PDF reading, structured output with tools, usage policy.
8. **Gemini**: classic `groundingMetadata` (`groundingChunks`, `groundingSupports`) not confirmed in the docs fetched (they described `url_citation` annotations and `google_search_call`/`google_search_result` steps). Moot given the terms conflict.
9. **Perplexity**: date-filter parameter names, ToS and background-mode pricing not verified; async Sonar chat completions reportedly discontinued [S].
10. **Companies House** key cost and accounts-document access; **FCA NSM** undocumented search endpoint; **EDINET** key registration terms; **IR RSS** coverage.
11. **EDGAR efts**: programmatic use is unsupported/undocumented; decide whether to depend on it.
12. **Legal**: Anthropic Usage Policy (High-risk finance, effective date shown as 2026-11-12) and the wording of the "Meets / Does not meet" conclusion; consult counsel. Anthropic's standard retention window not confirmed.
13. **JS-rendered IR sites**: web fetch docs say JavaScript-rendered sites are not supported [V]; expect failures on some IR pages, so keep the EDGAR/OAM prefetch as the backbone.
14. The cached claude-api skill model table (2026-09-25) listed Haiku 4.5 as the Haiku; the live docs (2026-10-15) show Haiku 5.5 released 2026-10-07, so the brief's Haiku 4.5 reference is already one generation old.

---

## 7. Sources (URL, title, date accessed)

All accessed 2026-10-15.

Anthropic
- https://platform.claude.com/docs/en/about-claude/pricing , "Pricing"
- https://platform.claude.com/docs/en/models/overview , "Models overview"
- https://platform.claude.com/docs/en/models/haiku-5-5/overview , "Claude Haiku 5.5" (released 2026-10-07)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool , "Web search tool"
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool , "Web fetch tool"
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools , "Server tools"
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference , "Tool reference"
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching , "Tool use with prompt caching"
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching , "Prompt caching"
- https://platform.claude.com/docs/en/build-with-claude/batch-processing , "Batch processing"
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs , "Structured outputs"
- https://platform.claude.com/docs/en/build-with-claude/citations , "Citations"
- https://platform.claude.com/docs/en/build-with-claude/streaming , "Streaming messages"
- https://platform.claude.com/docs/en/api/rate-limits , "Rate limits"
- https://platform.claude.com/docs/en/api/errors , "Claude API errors"
- https://platform.claude.com/docs/en/manage-claude/api-and-data-retention , "API and data retention"
- https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript , "TypeScript SDK"
- https://www.anthropic.com/legal/aup , "Anthropic Usage Policy" (shown effective 2026-11-12)
- claude-api skill (cached model table 2026-09-25, consistent with the live pricing page)

OpenAI
- https://developers.openai.com/api/docs/pricing , pricing (redirect from platform.openai.com/docs/pricing)
- https://developers.openai.com/api/docs/guides/tools-web-search , "Web search"
- https://developers.openai.com/api/docs/guides/background , "Background mode"
- https://openai.com/policies/usage-policies/ , HTTP 403 (not read)

Perplexity
- https://docs.perplexity.ai/guides/pricing
- https://docs.perplexity.ai/guides/search-domain-filters
- https://docs.perplexity.ai/guides/structured-outputs
- https://docs.perplexity.ai/api-reference/async-chat-completions-post
- https://docs.perplexity.ai/docs/agent-api/background-mode
- https://docs.perplexity.ai/guides/rate-limits-usage-tiers

Google
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/google-search
- https://ai.google.dev/gemini-api/docs/url-context
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/terms , "Gemini API Additional Terms of Service"

Primary-source filing APIs
- https://www.sec.gov/search-filings/edgar-application-programming-interfaces , "EDGAR Application Programming Interfaces"
- https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data , "Accessing EDGAR Data" (fair access)
- https://www.sec.gov/edgar/search/efts-faq.html , "EDGAR Full-Text Search FAQ"
- https://developer-specs.company-information.service.gov.uk/guides/rateLimiting , Companies House rate limiting
- https://developer-specs.company-information.service.gov.uk/guides/authorisation , Companies House API key authorisation
- https://filings.xbrl.org/api/filings , XBRL International filings index (ESEF)
- https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/WZEK0110.html , EDINET API spec page (spec PDF not read)
- Web searches (secondary, flagged [S]/[U]): EDINET v2 endpoint format; SEDAR+ no API; ESMA ESAP timeline (mondovisione.com ESMA ESAP phase-1 notice 2026-07-10; cyprus-mail.com 2026-07-14); FCA NSM API (no official result)

Platform
- https://supabase.com/docs/guides/functions/limits , "Edge Function limits"
