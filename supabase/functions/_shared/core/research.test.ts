import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyOperational } from "./classify.ts";
import {
  buildStage1User,
  buildStage2User,
  dateLabel,
  dateTerms,
  EVIDENCE_PREAMBLE,
  fillResearchPrompt,
  fitEvidence,
  industryKind,
  type LedgerEntry,
  PROMPT_VERSION,
  pickFilings,
  queryTemplates,
  quoteOccurs,
  type RankCandidate,
  RESEARCH_OUTPUT_SCHEMA,
  RESEARCH_PROMPT_TEMPLATE,
  type ResearchOutput,
  rankDocuments,
  renderSources,
  SCHEMA_VERSION,
  STAGE1_SYSTEM,
  selectDocuments,
  stripUrls,
  validateResearchOutput,
  validateStage1Facts,
  wordCount,
} from "./research.ts";

const fromRoot = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(fromRoot(p), "utf8").replace(/\r\n/g, "\n");

/** First fenced block after `marker`; `fence` is "```" or "~~~~". */
function fenced(source: string, marker: string, lang: string, fence = "```"): string {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf(`${fence}${lang}`, at);
  const bodyStart = source.indexOf("\n", open) + 1;
  const close = source.indexOf(`\n${fence}`, bodyStart);
  return source.slice(bodyStart, close);
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");

function validOutput(over: Partial<ResearchOutput> = {}): ResearchOutput {
  return {
    report_md: `${words(500)} [E1]`,
    summary: "It fell on a guidance cut; the verdict is positive.",
    news_reason: "Guidance cut after a weak quarter [E2].",
    conclusion: "Meets these two fundamental checks.",
    bankruptcy_risk: "Low",
    material_damage_established: false,
    sufficient_evidence: true,
    cited_evidence_ids: [2, 1],
    facts_vs_claims: [
      { section: "established_facts", items: [{ text: "Revenue fell 4%.", evidence_ids: [1] }] },
      {
        section: "management_claims",
        items: [{ text: "Management expects a recovery.", evidence_ids: [2] }],
      },
    ],
    missing_documents: [],
    limitations: [],
    research_cutoff_date: "2026-10-15",
    ...over,
  };
}
const LEDGER = [1, 2, 3];

const VARS = {
  companyName: "Acme Corp",
  ticker: "ACME",
  primaryExchange: "NasdaqGS",
  reportingCurrency: "USD",
  researchDate: "2026-10-15",
};

describe("verbatim prompt constants (spec 9.6, brief section 10)", () => {
  it("template equals prompt.txt lines 554-589 with the five placeholders substituted", () => {
    let expected = read("prompt.txt").split("\n").slice(553, 589).join("\n");
    for (const [from, to] of [
      ["[Company name]", "{{COMPANY_NAME}}"],
      ["[Ticker]", "{{TICKER}}"],
      ["[Exchange]", "{{PRIMARY_EXCHANGE}}"],
      ["[Currency]", "{{REPORTING_CURRENCY}}"],
      ["[Date]", "{{RESEARCH_DATE}}"],
    ] as const) {
      expect(expected).toContain(from);
      expected = expected.replace(from, to);
    }
    expect(RESEARCH_PROMPT_TEMPLATE).toBe(expected);
    expect(
      RESEARCH_PROMPT_TEMPLATE.startsWith(
        "Analyze this company for a potential long-term investment.",
      ),
    ).toBe(true);
    expect(
      RESEARCH_PROMPT_TEMPLATE.endsWith("Keep technical-analysis commentary outside this report."),
    ).toBe(true);
  });

  it("template equals the text in the design spec", () => {
    const spec = read("docs/superpowers/specs/2026-10-15-stock-screener-design.md");
    expect(RESEARCH_PROMPT_TEMPLATE).toBe(
      fenced(spec, "Core research prompt template", "text", "~~~~").trim(),
    );
  });

  it("uses exactly the five documented placeholders", () => {
    const found = new Set(RESEARCH_PROMPT_TEMPLATE.match(/\{\{[A-Z_]+\}\}/g));
    expect([...found].sort()).toEqual([
      "{{COMPANY_NAME}}",
      "{{PRIMARY_EXCHANGE}}",
      "{{REPORTING_CURRENCY}}",
      "{{RESEARCH_DATE}}",
      "{{TICKER}}",
    ]);
  });

  it("preamble and Stage 1 prompt equal the spec; schema equals the spec JSON", () => {
    const spec = read("docs/superpowers/specs/2026-10-15-stock-screener-design.md");
    expect(EVIDENCE_PREAMBLE).toBe(fenced(spec, "Evidence preamble (system role", "text").trim());
    expect(STAGE1_SYSTEM).toBe(fenced(spec, "**Stage 1 - extraction", "text").trim());
    expect(RESEARCH_OUTPUT_SCHEMA).toEqual(
      JSON.parse(fenced(spec, "### 9.6.1 Output JSON schema", "json")),
    );
  });

  it("versions are non-empty strings", () => {
    expect(PROMPT_VERSION).toMatch(/\S/);
    expect(SCHEMA_VERSION).toMatch(/\S/);
  });
});

describe("fillResearchPrompt", () => {
  it("substitutes every placeholder and leaves none behind", () => {
    const out = fillResearchPrompt(VARS);
    expect(out).toContain("**COMPANY:** Acme Corp");
    expect(out).toContain("**TICKER:** ACME");
    expect(out).toContain("**PRIMARY EXCHANGE:** NasdaqGS");
    expect(out).toContain("**REPORTING CURRENCY:** USD");
    expect(out).toContain("**RESEARCH DATE:** 2026-10-15");
    expect(out).not.toContain("{{");
  });

  it("rejects an empty variable and is safe against replacement patterns in values", () => {
    expect(() => fillResearchPrompt({ ...VARS, ticker: "  " })).toThrow(/TICKER/);
    expect(fillResearchPrompt({ ...VARS, companyName: "A $& B $1 Inc" })).toContain(
      "**COMPANY:** A $& B $1 Inc",
    );
  });
});

describe("queryTemplates and industry switch", () => {
  it("derives date terms", () => {
    expect(dateTerms("2026-10-15")).toEqual({
      year: 2026,
      month: "October",
      fiscalYear: 2025,
      quarter: "Q3 2026",
    });
    expect(dateTerms("2026-01-10").quarter).toBe("Q4 2025");
    expect(dateTerms("2026-04-01").quarter).toBe("Q1 2026");
    expect(() => dateTerms("nonsense")).toThrow();
  });

  it("builds the six general templates", () => {
    expect(
      queryTemplates({
        company: "Acme Corp",
        ticker: "ACME",
        researchDate: "2026-10-15",
        industry: "general",
      }),
    ).toEqual([
      "Acme Corp ACME annual report 2025 investor relations",
      "Acme Corp latest quarterly interim results Q3 2026",
      "Acme Corp shares fall reason October 2026",
      "Acme Corp debt maturities refinancing covenants liquidity",
      "Acme Corp going concern OR credit rating downgrade OR investigation OR restatement",
      "Acme Corp guidance outlook management commentary",
    ]);
  });

  it("switches terms 4 and 6 for banks and insurers", () => {
    const q = queryTemplates({
      company: "First Bank",
      ticker: "FBK",
      researchDate: "2026-10-15",
      industry: "financial",
    });
    expect(q).toHaveLength(6);
    expect(q[3]).toBe(
      "First Bank debt maturities refinancing covenants liquidity regulatory capital liquidity asset quality",
    );
    expect(q[5]).toBe(
      "First Bank regulatory capital liquidity asset quality regulatory disclosure",
    );
    expect(q.every((s) => !/ {2}/.test(s))).toBe(true);
  });

  it("detects financial sectors", () => {
    expect(industryKind("Financial Services", "Banks - Regional")).toBe("financial");
    expect(industryKind("Technology", "Software")).toBe("general");
    expect(industryKind(null, "Insurance - Life")).toBe("financial");
    expect(industryKind(null, null)).toBe("general");
  });
});

describe("rankDocuments and selectDocuments", () => {
  const c = (over: Partial<RankCandidate> & { evidenceId: number }): RankCandidate => ({
    url: `https://x.example/${over.evidenceId}`,
    kind: "search_result",
    ...over,
  });
  const candidates: RankCandidate[] = [
    c({ evidenceId: 1, url: "https://news.example.com/a", publishedAt: "2026-10-10T00:00:00Z" }),
    c({
      evidenceId: 2,
      kind: "edgar_filing",
      form: "8-K",
      filingDate: "2026-10-01",
      url: "https://www.sec.gov/a8k",
    }),
    c({
      evidenceId: 3,
      kind: "edgar_filing",
      form: "10-K",
      filingDate: "2026-02-20",
      url: "https://www.sec.gov/a10k",
    }),
    c({ evidenceId: 4, kind: "ir_page", url: "https://investors.acme.com/q3" }),
    c({ evidenceId: 5, url: "https://www.fca.org.uk/news/x" }),
    c({
      evidenceId: 6,
      kind: "edgar_filing",
      form: "10-Q",
      filingDate: "2026-08-01",
      url: "https://www.sec.gov/a10q",
    }),
    c({
      evidenceId: 7,
      kind: "yahoo_news",
      url: "https://finance.yahoo.com/n/1",
      publishedAt: "2026-10-12T00:00:00Z",
    }),
  ];

  it("orders EDGAR annual, interim, current, then IR, regulators, independent (newest first)", () => {
    expect(rankDocuments(candidates).map((x) => x.evidenceId)).toEqual([3, 6, 2, 4, 5, 7, 1]);
  });

  it("is deterministic for any input order", () => {
    const shuffled = [...candidates].reverse();
    expect(rankDocuments(shuffled).map((x) => x.evidenceId)).toEqual(
      rankDocuments(candidates).map((x) => x.evidenceId),
    );
  });

  it("takes at most 3 EDGAR filings and 8 documents overall", () => {
    const many: RankCandidate[] = [
      ...["10-K", "10-Q", "8-K", "8-K", "8-K"].map((form, i) =>
        c({
          evidenceId: 10 + i,
          kind: "edgar_filing",
          form,
          filingDate: `2026-0${i + 1}-01`,
          url: `https://www.sec.gov/f${i}`,
        }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        c({ evidenceId: 20 + i, url: `https://news.example.com/${i}` }),
      ),
    ];
    const picked = selectDocuments(rankDocuments(many));
    expect(picked).toHaveLength(8);
    expect(picked.filter((x) => x.kind === "edgar_filing")).toHaveLength(3);
    expect(picked.slice(0, 3).map((x) => x.form)).toEqual(["10-K", "10-Q", "8-K"]);
  });
});

describe("pickFilings", () => {
  const f = (form: string, filingDate: string, accession: string) => ({
    form,
    filingDate,
    accession,
    primaryDocument: `${accession}.htm`,
  });
  it("returns the latest annual, the latest interim and current reports filed since the annual", () => {
    const picked = pickFilings([
      f("8-K", "2026-10-02", "a5"),
      f("10-Q", "2026-08-01", "a4"),
      f("8-K", "2026-03-01", "a3"),
      f("10-K", "2026-02-20", "a2"),
      f("8-K", "2026-01-05", "a1"),
      f("10-K", "2025-02-20", "a0"),
    ]);
    expect(picked.annual?.accession).toBe("a2");
    expect(picked.interim?.accession).toBe("a4");
    expect(picked.current.map((x) => x.accession)).toEqual(["a5", "a3"]);
  });

  it("handles foreign filers and missing filings", () => {
    const picked = pickFilings([f("6-K", "2026-09-01", "b2"), f("20-F", "2026-04-01", "b1")]);
    expect(picked.annual?.form).toBe("20-F");
    expect(picked.interim).toBeNull();
    expect(picked.current.map((x) => x.accession)).toEqual(["b2"]);
    expect(pickFilings([])).toEqual({ annual: null, interim: null, current: [] });
  });
});

describe("quote check", () => {
  const text = "The company   reported a net\nloss of $4.2 million.\tLiquidity remains adequate.";
  it("matches after whitespace normalisation, case-sensitively", () => {
    expect(quoteOccurs("reported a net loss of $4.2 million.", text)).toBe(true);
    expect(quoteOccurs("  Liquidity   remains\nadequate. ", text)).toBe(true);
    expect(quoteOccurs("REPORTED A NET LOSS", text)).toBe(false);
    expect(quoteOccurs("net profit of $4.2 million", text)).toBe(false);
  });
  it("rejects empty quotes and quotes longer than 300 characters", () => {
    expect(quoteOccurs("   ", text)).toBe(false);
    const long = "a".repeat(301);
    expect(quoteOccurs(long, long)).toBe(false);
    expect(quoteOccurs("a".repeat(300), "a".repeat(300))).toBe(true);
  });
  it("validateStage1Facts drops facts whose quote is not in the document", () => {
    const res = validateStage1Facts(
      {
        facts: [
          {
            topic: "liquidity",
            claim: "Liquidity is adequate.",
            claim_type: "management_claim",
            quote: "Liquidity remains adequate.",
            where: "MD&A",
          },
          {
            topic: "going_concern",
            claim: "Going concern doubt.",
            claim_type: "established_fact",
            quote: "substantial doubt about going concern",
            where: "Note 1",
          },
          {
            topic: "bogus",
            claim: "x",
            claim_type: "established_fact",
            quote: "net loss",
            where: "",
          },
          { topic: "other", claim: "y", claim_type: "rumour", quote: "net loss", where: "" },
        ],
      },
      text,
    );
    expect(res.valid).toBe(true);
    expect(res.kept.map((x) => x.topic)).toEqual(["liquidity", "other"]);
    expect(res.dropped).toBe(2);
    expect(validateStage1Facts({ nothing: true }, text).valid).toBe(false);
    expect(validateStage1Facts({ facts: [] }, text)).toEqual({ valid: true, kept: [], dropped: 0 });
  });
});

describe("validateResearchOutput (spec 9.6.1 code checks)", () => {
  it("accepts a well-formed, consistent output and sorts cited ids", () => {
    const res = validateResearchOutput(validOutput(), LEDGER, 1);
    expect(res.ok).toBe(true);
    expect(res.limitations).toEqual([]);
    expect(res.output?.cited_evidence_ids).toEqual([1, 2]);
    expect(res.inconsistent).toBe(false);
  });

  it("unions inline [E#] markers and per-item ids into cited_evidence_ids", () => {
    const res = validateResearchOutput(
      validOutput({
        report_md: `${words(500)} [E1] [E3]`,
        cited_evidence_ids: [1],
        facts_vs_claims: [
          {
            section: "established_facts",
            items: [{ text: "Revenue fell 4%.", evidence_ids: [1] }],
          },
          { section: "management_claims", items: [{ text: "Recovery.", evidence_ids: [2] }] },
        ],
      }),
      LEDGER,
      1,
    );
    expect(res.ok).toBe(true);
    expect(res.output?.cited_evidence_ids).toEqual([1, 2, 3]);
  });

  it("schema failure: retry once, then invalid_json", () => {
    const bad = { ...validOutput(), conclusion: "Maybe." };
    const first = validateResearchOutput(bad, LEDGER, 1);
    expect(first.ok).toBe(false);
    expect(first.retryWith).toMatch(/schema/i);
    const second = validateResearchOutput(bad, LEDGER, 2);
    expect(second).toMatchObject({ ok: false, failure: "invalid_json" });
    expect(second.retryWith).toBeUndefined();
    expect(validateResearchOutput("nope", LEDGER, 1).ok).toBe(false);
    const { conclusion: _drop, ...missing } = validOutput();
    expect(validateResearchOutput(missing, LEDGER, 1).ok).toBe(false);
  });

  it("rejects unknown evidence ids in cited ids, fact items and [E9] markers in report_md", () => {
    for (const out of [
      validOutput({ cited_evidence_ids: [1, 9] }),
      validOutput({
        facts_vs_claims: [{ section: "interpretation", items: [{ text: "x", evidence_ids: [9] }] }],
      }),
      validOutput({ report_md: `${words(500)} see [E9]` }),
    ]) {
      const first = validateResearchOutput(out, LEDGER, 1);
      expect(first.ok).toBe(false);
      expect(first.retryWith).toContain("E9");
      expect(validateResearchOutput(out, LEDGER, 2)).toMatchObject({
        ok: false,
        failure: "unknown_evidence_id",
      });
    }
  });

  it("an established fact without evidence is retried, then dropped with a limitation", () => {
    const out = validOutput({
      facts_vs_claims: [
        {
          section: "established_facts",
          items: [
            { text: "Cited.", evidence_ids: [1] },
            { text: "Uncited.", evidence_ids: [] },
          ],
        },
      ],
    });
    expect(validateResearchOutput(out, LEDGER, 1).ok).toBe(false);
    const second = validateResearchOutput(out, LEDGER, 2);
    expect(second.ok).toBe(true);
    expect(second.limitations).toContain("dropped_uncited_established_facts:1");
    expect(second.output?.facts_vs_claims[0]?.items.map((i) => i.text)).toEqual(["Cited."]);
  });

  it("word count outside 350-1,100 is retried, then stored with a limitation", () => {
    for (const n of [100, 1200]) {
      const out = validOutput({ report_md: `${words(n)} [E1]` });
      const first = validateResearchOutput(out, LEDGER, 1);
      expect(first.ok).toBe(false);
      expect(first.retryWith).toMatch(/500-800/);
      const second = validateResearchOutput(out, LEDGER, 2);
      expect(second.ok).toBe(true);
      expect(second.limitations[0]).toMatch(/^report_length_out_of_range:/);
    }
    expect(wordCount("## Heading\n\n- **bold** long-term plan")).toBe(4);
    const lim = (n: number) =>
      validateResearchOutput(validOutput({ report_md: `${words(n)} [E1]` }), LEDGER, 2).limitations;
    expect(lim(348)).toHaveLength(1); // 349 words
    expect(lim(349)).toHaveLength(0); // 350 words
    expect(lim(1099)).toHaveLength(0); // 1,100 words
    expect(lim(1100)).toHaveLength(1); // 1,101 words
  });

  it("consistency rule: Meets with no cited evidence and no established facts is inconsistent", () => {
    const out = validOutput({
      cited_evidence_ids: [],
      report_md: validOutput().report_md.replace(/\s*\[E\d+\]/g, ""),
      facts_vs_claims: [
        { section: "established_facts", items: [] },
        {
          section: "management_claims",
          items: [{ text: "Management expects a recovery.", evidence_ids: [2] }],
        },
      ],
    });
    const first = validateResearchOutput(out, LEDGER, 1);
    expect(first.ok).toBe(false);
    expect(first.retryWith).toMatch(/Reconcile/);
    const second = validateResearchOutput(out, LEDGER, 2);
    expect(second.ok).toBe(true);
    expect(second.inconsistent).toBe(true);
    expect(second.limitations).toContain("inconsistent_output");
  });

  it("consistency rule: Meets needs sufficient evidence, no established damage and Low/Moderate risk", () => {
    const variants = [
      validOutput({ sufficient_evidence: false }),
      validOutput({ material_damage_established: true }),
      validOutput({ bankruptcy_risk: "High" }),
      validOutput({ bankruptcy_risk: "Unclear" }),
    ];
    for (const out of variants) {
      const first = validateResearchOutput(out, LEDGER, 1);
      expect(first.ok).toBe(false);
      expect(first.retryWith).toMatch(/Reconcile/);
      const second = validateResearchOutput(out, LEDGER, 2);
      expect(second.ok).toBe(true);
      expect(second.inconsistent).toBe(true);
      expect(second.limitations).toContain("inconsistent_output");
      expect(second.output?.conclusion).toBe("Meets these two fundamental checks.");
      const facts = {
        status: "complete" as const,
        conclusion: out.conclusion,
        bankruptcyRisk: out.bankruptcy_risk,
        materialDamageEstablished: out.material_damage_established,
        sufficientEvidence: out.sufficient_evidence,
      };
      expect(classifyOperational(facts).category).not.toBe("green");
    }
  });

  it("conclusion and bankruptcy risk are stored independently (never derived from each other)", () => {
    const out = validOutput({
      conclusion: "Does not meet one or both checks.",
      bankruptcy_risk: "Low",
      material_damage_established: true,
    });
    const res = validateResearchOutput(out, LEDGER, 1);
    expect(res.ok).toBe(true);
    expect(res.output?.conclusion).toBe("Does not meet one or both checks.");
    expect(res.output?.bankruptcy_risk).toBe("Low");
    expect(res.limitations).toEqual([]);
  });

  it("combines every retryable problem into one feedback message", () => {
    const out = validOutput({
      report_md: `${words(50)} [E1]`,
      sufficient_evidence: false,
      cited_evidence_ids: [1, 8],
    });
    const first = validateResearchOutput(out, LEDGER, 1);
    expect(first.retryWith).toContain("E8");
    expect(first.retryWith).toMatch(/500-800/);
    expect(first.retryWith).toMatch(/Reconcile/);
  });

  it("strips URLs typed by the model from every text field", () => {
    const out = validOutput({
      report_md: `${words(500)} see https://evil.example/x?a=1 and www.evil.example/y [E1]`,
      summary: "Details at http://evil.example",
      facts_vs_claims: [
        {
          section: "interpretation",
          items: [{ text: "Source: https://evil.example/z", evidence_ids: [1] }],
        },
      ],
    });
    const res = validateResearchOutput(out, LEDGER, 1);
    expect(res.ok).toBe(true);
    const serialized = JSON.stringify(res.output);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toContain("www.evil");
    expect(res.output?.report_md).toContain("[link removed]");
    expect(stripUrls("a https://x.example/p?q=1) b")).toBe("a [link removed]) b");
  });
});

describe("renderSources", () => {
  const entry = (over: Partial<LedgerEntry> & { evidenceId: number }): LedgerEntry => ({
    url: `https://s.example/${over.evidenceId}`,
    title: `Doc ${over.evidenceId}`,
    publisher: "Pub",
    kind: "other",
    publishedAt: null,
    filingDate: null,
    retrievedAt: "2026-10-15T08:00:00Z",
    verification: "ok",
    facts: [],
    ...over,
  });

  it("renders only ledger rows, in evidence order, with a date label per source", () => {
    const md = renderSources([
      entry({
        evidenceId: 3,
        kind: "search_result",
        publishedAt: "2026-09-01T00:00:00Z",
        title: "Search [hit]",
      }),
      entry({
        evidenceId: 1,
        kind: "edgar_filing",
        filingDate: "2026-02-20",
        publisher: "SEC EDGAR",
        title: "10-K",
      }),
      entry({ evidenceId: 2, kind: "rss", publishedAt: "2026-10-01T10:00:00Z", publisher: null }),
      entry({ evidenceId: 4 }),
    ]);
    const lines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(md.startsWith("## Sources")).toBe(true);
    expect(lines).toEqual([
      "- [E1] [10-K](https://s.example/1) - SEC EDGAR - filing date 2026-02-20",
      "- [E2] [Doc 2](https://s.example/2) - publisher not available - published 2026-10-01",
      "- [E3] [Search (hit)](https://s.example/3) - Pub - date as reported by search 2026-09-01",
      "- [E4] [Doc 4](https://s.example/4) - Pub - date not available",
    ]);
    expect(renderSources([])).toContain("No sources");
  });

  it("dateLabel never presents a page age as a publication date", () => {
    expect(dateLabel({ kind: "ir_page", publishedAt: null, filingDate: null })).toBe(
      "date not available",
    );
  });
});

describe("prompt builders", () => {
  const e = (id: number, facts: LedgerEntry["facts"] = []): LedgerEntry => ({
    evidenceId: id,
    url: `https://s.example/${id}`,
    title: `Title "${id}"`,
    publisher: "P",
    kind: "edgar_filing",
    publishedAt: null,
    filingDate: "2026-02-20",
    retrievedAt: "2026-10-15T08:00:00Z",
    verification: "ok",
    facts,
  });
  const fact = {
    topic: "liquidity" as const,
    claim: "Cash is $1B.",
    claim_type: "established_fact" as const,
    quote: "cash of $1 billion",
    where: "p.3",
  };

  it("buildStage1User carries the metadata and the capped text", () => {
    const u = buildStage1User({
      evidenceId: 3,
      title: "10-K 2025",
      kind: "edgar_filing",
      dateLabel: "filing date 2026-02-20",
      url: "https://s.example/3",
      text: "BODY TEXT",
    });
    expect(u).toContain("evidence_id: E3");
    expect(u).toContain("title: 10-K 2025");
    expect(u).toContain("date: filing date 2026-02-20");
    expect(u.endsWith("BODY TEXT")).toBe(true);
  });

  it("buildStage2User follows spec 9.6: prompt, cutoff, industry, deterministic data, ledger, missing", () => {
    const u = buildStage2User({
      vars: VARS,
      industryNote: "bank/insurer: use regulatory capital, liquidity, asset quality",
      deterministicData: "- 10-K filed 2026-02-20",
      shown: [e(1, [fact]), e(2)],
      missing: ["Latest quarterly report: not retrieved"],
    });
    expect(u.startsWith("Analyze this company")).toBe(true);
    expect(u).toContain(
      "RESEARCH CUTOFF DATE: 2026-10-15  (state this date in research_cutoff_date)",
    );
    expect(u).toContain("INDUSTRY GUIDANCE: bank/insurer");
    expect(u).toContain("DETERMINISTIC DATA (from EDGAR, may be empty): - 10-K filed 2026-02-20");
    expect(u).toContain(
      "[E1] kind=edgar_filing title=\"Title '1'\" date=filing date 2026-02-20 retrieved=2026-10-15T08:00:00Z",
    );
    expect(u).toContain('facts: - (established_fact) Cash is $1B.  | quote: "cash of $1 billion"');
    expect(u).toContain("MISSING OR FAILED RETRIEVALS: Latest quarterly report: not retrieved");
    expect(u).not.toContain("{{");
  });

  it("buildStage2User states empty inputs explicitly and appends correction feedback", () => {
    const u = buildStage2User({
      vars: VARS,
      industryNote: "n",
      deterministicData: " ",
      shown: [],
      missing: [],
      feedback: "Cite only E1.",
    });
    expect(u).toContain("DETERMINISTIC DATA (from EDGAR, may be empty): none");
    expect(u).toContain("no evidence items were obtained");
    expect(u).toContain("MISSING OR FAILED RETRIEVALS: none");
    expect(u.endsWith("CORRECTION REQUIRED: Cite only E1.")).toBe(true);
  });

  it("fitEvidence keeps the evidence block inside the character budget and reports what it omitted", () => {
    const big = { ...fact, claim: "c".repeat(400) };
    const entries = Array.from({ length: 10 }, (_, i) => e(i + 1, [big, big, big]));
    const { shown, omitted } = fitEvidence(entries, 3000);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length + omitted.length).toBe(10);
    expect(shown.map((x) => x.evidenceId)).toEqual(
      [...shown.map((x) => x.evidenceId)].sort((a, b) => a - b),
    );
    const all = fitEvidence(entries.slice(0, 1), 48_000);
    expect(all.omitted).toEqual([]);
    expect(all.shown[0]?.facts).toHaveLength(3);
  });
});
