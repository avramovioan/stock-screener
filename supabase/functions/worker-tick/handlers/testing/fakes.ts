import type { DocFetchResult } from "../../../_shared/adapters/fetchers/direct.ts";
import type { EdgarClient, Filing } from "../../../_shared/adapters/fetchers/edgar.ts";
import type { JinaResult } from "../../../_shared/adapters/fetchers/jina.ts";
import type {
  GenerateJsonRequest,
  GenerateJsonResult,
  LlmBudget,
  LlmProvider,
} from "../../../_shared/adapters/llm/types.ts";
import {
  DEFAULT_RESEARCH_SETTINGS,
  type FetchPort,
  type HandlerCtx,
  type Job,
  type ResearchDeps,
  type ResearchSettings,
  type SecurityContext,
  type YahooNewsItem,
} from "../../../_shared/adapters/research_types.ts";
import type {
  SearchHit,
  TavilyClient,
  TavilyResult,
} from "../../../_shared/adapters/search/tavily.ts";
import {
  EVIDENCE_PREAMBLE,
  type ResearchOutput,
  STAGE1_SYSTEM,
} from "../../../_shared/core/research.ts";
import { researchHandler } from "../research.ts";
import { FakeStore } from "./fake_store.ts";

export const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");

export type Verdict = "green" | "amber" | "red" | "inconsistent" | "unknown_id" | "cite_unverified";

export class FakeLlm implements LlmProvider {
  calls: GenerateJsonRequest[] = [];
  /** Counter value of this provider's daily quota at the moment of each call (proves reserve-before-call). */
  quotaSeen: number[] = [];
  onCall: (() => void) | undefined;
  constructor(
    readonly name = "gemini",
    readonly model = "fake-model",
    readonly configured = true,
    public responder: (req: GenerateJsonRequest) => GenerateJsonResult<unknown> = () => ({
      ok: false,
      kind: "http",
      message: "no responder",
    }),
    public budget?: LlmBudget | undefined,
  ) {}
  async generateJson<T>(req: GenerateJsonRequest): Promise<GenerateJsonResult<T>> {
    this.onCall?.();
    this.calls.push(req);
    if (!this.configured) return { ok: false, kind: "not_configured", message: "not configured" };
    return this.responder(req) as GenerateJsonResult<T>;
  }
  get stage1Calls() {
    return this.calls.filter((c) => c.system === STAGE1_SYSTEM);
  }
  get stage2Calls() {
    return this.calls.filter((c) => c.system === EVIDENCE_PREAMBLE);
  }
}

/** Builds Stage 1 and Stage 2 answers from the prompt itself so quotes and evidence ids always match the ledger. */
export function scriptedResponder(getVerdict: () => Verdict) {
  return (req: GenerateJsonRequest): GenerateJsonResult<unknown> => {
    const usage = { input: 100, output: 50 };
    if (req.system === STAGE1_SYSTEM) {
      const body = req.user.split("DOCUMENT TEXT:\n")[1] ?? "";
      const quote = body.slice(0, 60).replace(/\s+/g, " ").trim();
      return {
        ok: true,
        usage,
        model: "fake-model",
        json: {
          facts: [
            {
              topic: "liquidity",
              claim: "The company reports its liquidity position.",
              claim_type: "management_claim",
              quote,
              where: "p.1",
            },
          ],
        },
      };
    }
    const ids = [...req.user.matchAll(/\[E(\d+)\] kind=\w+/g)].map((m) => Number(m[1]));
    const headlineIds = [
      ...req.user.matchAll(
        /\[E(\d+)\] kind=\w+[^\n]*\n\s+facts: \(no facts extracted; headline only\)/g,
      ),
    ].map((m) => Number(m[1]));
    const first = ids.slice(0, 2);
    const verdict = getVerdict();
    const base: ResearchOutput = {
      report_md: `${words(500)} [E${first[0] ?? 1}]`,
      summary: "Fell on weak guidance; the verdict follows the evidence.",
      news_reason: "Guidance cut.",
      conclusion: "Meets these two fundamental checks.",
      bankruptcy_risk: "Low",
      material_damage_established: false,
      sufficient_evidence: true,
      cited_evidence_ids: first,
      facts_vs_claims: [
        {
          section: "established_facts",
          items: [
            { text: "Liquidity is described in the filing.", evidence_ids: first.slice(0, 1) },
          ],
        },
      ],
      missing_documents: [],
      limitations: [],
      research_cutoff_date: "2026-10-15",
    };
    if (verdict === "amber") base.bankruptcy_risk = "Moderate";
    if (verdict === "red") {
      base.conclusion = "Does not meet one or both checks.";
      base.bankruptcy_risk = "High";
      base.material_damage_established = true;
    }
    if (verdict === "inconsistent") base.sufficient_evidence = false;
    if (verdict === "unknown_id") base.cited_evidence_ids = [999];
    if (verdict === "cite_unverified")
      base.cited_evidence_ids = [...first, ...headlineIds].slice(0, 7);
    return { ok: true, usage, model: "fake-model", json: base };
  };
}

export class FakeTavily implements TavilyClient {
  queries: string[] = [];
  mode: "ok" | "quota" | "rate_limited" = "ok";
  configured = true;
  /** Daily Tavily counter at the moment of each call. */
  quotaSeen: number[] = [];
  constructor(private readonly store: FakeStore) {}
  async search(query: string): Promise<TavilyResult> {
    this.quotaSeen.push(this.store.quota.get("tavily|credits|day") ?? 0);
    this.queries.push(query);
    if (this.mode === "quota") return { ok: false, kind: "quota", status: 432, message: "limit" };
    if (this.mode === "rate_limited")
      return { ok: false, kind: "rate_limited", status: 429, message: "per minute" };
    const n = this.queries.length;
    const hits: SearchHit[] = [
      {
        url: `https://investors.acme.example/doc-${n}`,
        title: `IR document ${n}`,
        snippet: "investor relations",
        publishedDate: "2026-09-01",
      },
      { url: `https://news.example.com/story-${n}`, title: `Story ${n}`, snippet: "shares fell" },
    ];
    return { ok: true, results: hits };
  }
}

export class FakeFetch implements FetchPort {
  directCalls: string[] = [];
  jinaCalls: string[] = [];
  failUrls = new Set<string>();
  /** Words in every fetched document body (80 = a short page; 8000 = a long filing, cut to the document cap). */
  bodyWords = 80;
  feedItems: { guid: string; title: string; link: string; published: string | null }[] = [];
  /** Timeouts of the direct calls: the validate step's liveness GETs are the ones with 8000 ms. */
  directTimeouts: (number | undefined)[] = [];
  async direct(url: string, opts?: { timeoutMs?: number | undefined }): Promise<DocFetchResult> {
    this.directCalls.push(url);
    this.directTimeouts.push(opts?.timeoutMs);
    if (this.failUrls.has(url))
      return { ok: false, kind: "http", status: 404, message: "HTTP 404" };
    return {
      ok: true,
      status: 200,
      contentType: "text/html",
      text: `Document body for ${url}. ${words(this.bodyWords)}`,
      truncated: false,
      finalUrl: url,
      dnsCheck: "skipped",
      bytes: 500,
    };
  }
  async jina(url: string): Promise<JinaResult> {
    this.jinaCalls.push(url);
    if (this.failUrls.has(url))
      return { ok: false, kind: "http", status: 404, message: "HTTP 404" };
    return { ok: true, status: 200, text: `Reader text for ${url}. ${words(this.bodyWords)}` };
  }
  async feed() {
    return { ok: true as const, items: this.feedItems };
  }
}

export class FakeEdgar implements EdgarClient {
  filings: Filing[] = [
    {
      form: "8-K",
      accession: "0000000001-26-000003",
      filingDate: "2026-10-02",
      primaryDocument: "k8.htm",
      reportDate: null,
    },
    {
      form: "10-Q",
      accession: "0000000001-26-000002",
      filingDate: "2026-08-01",
      primaryDocument: "q.htm",
      reportDate: "2026-06-30",
    },
    {
      form: "10-K",
      accession: "0000000001-26-000001",
      filingDate: "2026-02-20",
      primaryDocument: "k.htm",
      reportDate: "2025-12-31",
    },
  ];
  calls: string[] = [];
  async resolveCik(ticker: string) {
    this.calls.push(`cik:${ticker}`);
    return { ok: true as const, value: "0000000001" };
  }
  async submissions(cik: string) {
    this.calls.push(`sub:${cik}`);
    return { ok: true as const, value: this.filings };
  }
  filingUrl(cik: string, accession: string, doc: string) {
    return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/${doc}`;
  }
}

export const SEC_1: SecurityContext = {
  securityId: "sec-1",
  companyId: "co-1",
  companyName: "Acme Corp",
  ticker: "ACME",
  primaryExchange: "NasdaqGS",
  reportingCurrency: "USD",
  sector: "Technology",
  industry: "Software",
  secCik: "0000000001",
  irRssUrls: [],
  newsSymbol: null,
};

export interface World {
  store: FakeStore;
  llm: FakeLlm;
  /** The backup provider when `makeWorld({ alternate: true })`, else null. */
  alt: FakeLlm | null;
  tavily: FakeTavily;
  fetch: FakeFetch;
  edgar: FakeEdgar;
  deps: ResearchDeps;
  logs: { event: string; data?: Record<string, unknown> | undefined }[];
  yahoo: { items: YahooNewsItem[]; calls: string[]; fail: boolean };
  verdict: { value: Verdict };
  clock: { now: Date };
  settings: { value: ResearchSettings };
  /** Runs one job directly (no queue). */
  handle(job: Job, ctx?: Partial<HandlerCtx>): Promise<unknown>;
  /** Runs queued jobs FIFO by priority, each due job once; returns the number of executions. */
  drain(ctx?: Partial<HandlerCtx>, maxExecutions?: number): Promise<number>;
  /** Enqueues `first` and drains. */
  run(first: Job, ctx?: Partial<HandlerCtx>, maxExecutions?: number): Promise<number>;
}

export function makeWorld(
  opts: {
    configured?: boolean;
    security?: SecurityContext;
    /** A second provider (Mistral, "mistral-large-latest") behind the primary; true = configured. */
    alternate?: boolean;
  } = {},
): World {
  const store = new FakeStore();
  const security = opts.security ?? SEC_1;
  store.securities.set(security.securityId, { ...security });
  store.scanRuns.push({ id: "run-1", scanDateLocal: "2026-10-15" });
  store.cards.push({
    id: 1,
    scanRunId: "run-1",
    mode: "worldwide",
    securityId: security.securityId,
    rank: 53,
    symbol: security.ticker,
    researchReportId: null,
    operationalCategory: "pending",
  });
  const verdict = { value: "green" as Verdict };
  const llm = new FakeLlm(
    "gemini",
    "fake-model",
    opts.configured ?? true,
    scriptedResponder(() => verdict.value),
  );
  llm.onCall = () => llm.quotaSeen.push(store.quota.get("gemini|llm_requests|day") ?? 0);
  const alt = opts.alternate
    ? new FakeLlm(
        "mistral",
        "mistral-large-latest",
        true,
        scriptedResponder(() => verdict.value),
      )
    : null;
  const tavily = new FakeTavily(store);
  const fetch = new FakeFetch();
  const edgar = new FakeEdgar();
  const logs: World["logs"] = [];
  const yahoo = { items: [] as YahooNewsItem[], calls: [] as string[], fail: false };
  const clock = { now: new Date("2026-10-15T08:00:00Z") };
  const settings = { value: { ...DEFAULT_RESEARCH_SETTINGS } };
  const deps: ResearchDeps = {
    store,
    llm: alt ? { gemini: llm, mistral: alt } : { gemini: llm },
    llmOrder: alt ? ["gemini", "mistral"] : ["gemini"],
    tavily,
    fetch,
    edgar,
    yahooNews: async (symbol) => {
      yahoo.calls.push(symbol);
      if (yahoo.fail) throw new Error("yahoo down");
      return yahoo.items;
    },
    settings: async () => settings.value,
    now: () => clock.now,
    sha256: async (text) => `sha:${text.length}`,
    log: async (event, data) => {
      logs.push({ event, data });
    },
    secUserAgent: "Screener admin@example.com",
  };
  const handler = researchHandler(deps);
  const context = (ctx: Partial<HandlerCtx> = {}): HandlerCtx => ({
    signal: new AbortController().signal,
    deadline: performance.now() + 120_000,
    ...ctx,
  });
  const world: World = {
    store,
    llm,
    alt,
    tavily,
    fetch,
    edgar,
    deps,
    logs,
    yahoo,
    verdict,
    clock,
    settings,
    handle: (job, ctx) => handler(job, context(ctx)),
    async drain(ctx, maxExecutions = 200) {
      let executed = 0;
      while (executed < maxExecutions) {
        const due = store.jobs
          .filter((j) => j.status === "queued" && (j.notBefore ?? "") <= clock.now.toISOString())
          .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id - b.id)[0];
        if (!due) break;
        due.status = "done";
        executed++;
        await handler(
          {
            id: due.id,
            scan_run_id: due.scanRunId,
            stage: due.stage,
            key: due.key,
            payload: due.payload,
          },
          context(ctx),
        );
      }
      return executed;
    },
    async run(first, ctx, maxExecutions) {
      await store.enqueueJob({
        scanRunId: first.scan_run_id,
        stage: "research",
        key: first.key,
        payload: first.payload,
        priority: 10,
      });
      return await world.drain(ctx, maxExecutions);
    },
  };
  return world;
}

export function planJob(
  over: Record<string, unknown> = {},
  securityId = "sec-1",
  trigger = "new_discount",
): Job {
  return {
    id: 0,
    scan_run_id: "run-1",
    stage: "research",
    key: `research:${securityId}:${trigger}:plan`,
    payload: {
      security_id: securityId,
      trigger,
      scan_run_id: "run-1",
      scan_date_local: "2026-10-15",
      ...over,
    },
  };
}
