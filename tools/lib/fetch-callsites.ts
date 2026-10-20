export type FetchCategory =
  | "fixed-host"
  | "ssrf-guarded"
  | "endpoint-allow-listed"
  | "operator-configured";

export interface FetchPolicy {
  category: FetchCategory;
  reason: string;
  /** Strings that must appear in the file (the guard it relies on). */
  requires?: string[];
}
export interface SourceFile {
  file: string;
  text: string;
}
export interface Callsite {
  file: string;
  line: number;
  text: string;
}

const CALL = /\b(?:fetch|fetchImpl|doFetch)\s*\(/;

export function findFetchCalls(file: string, text: string): Callsite[] {
  const out: Callsite[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (CALL.test(raw)) out.push({ file, line: index + 1, text: trimmed });
  });
  return out;
}

/**
 * Reviewed outbound call sites (spec 15.2 T12). A file with a `fetch(` call that is not listed here fails
 * `bun run check:fetch`: review the URL source, then add it with the matching category.
 */
export const FETCH_POLICY: Record<string, FetchPolicy> = {
  "supabase/functions/worker-tick/handlers/eur_register.ts": {
    category: "fixed-host",
    reason: "passes the global fetch to the IBKR catalogue client (ibkr-catalogue.ts)",
  },
  "supabase/functions/_shared/adapters/ibkr-catalogue.ts": {
    category: "fixed-host",
    reason:
      "www.interactivebrokers.com; only our own exchange ids enter the request body, CATALOGUE_ENDPOINT is a constant",
  },
  "supabase/functions/_shared/adapters/yahoo.ts": {
    category: "fixed-host",
    reason:
      "Yahoo hosts used by yahoo-finance2 and the recorder wrapper (query1, query2, fc); symbols never form a host",
  },
  "supabase/functions/_shared/adapters/throttle.ts": {
    category: "fixed-host",
    reason: "wraps the Yahoo fetch; URLs come from yahoo.ts and session.ts",
  },
  "supabase/functions/_shared/adapters/session.ts": {
    category: "fixed-host",
    reason: "fc.yahoo.com and query1.finance.yahoo.com crumb endpoints (constants)",
  },
  "supabase/functions/_shared/adapters/fx.ts": {
    category: "fixed-host",
    reason: "api.frankfurter.dev (FRANKFURTER_URL) plus ISO currency codes in the query",
  },
  "supabase/functions/_shared/adapters/search/tavily.ts": {
    category: "fixed-host",
    reason: "api.tavily.com",
  },
  "supabase/functions/_shared/adapters/llm/gemini.ts": {
    category: "fixed-host",
    reason: "generativelanguage.googleapis.com; the model name is URL-encoded",
  },
  "supabase/functions/_shared/adapters/llm/openai-compatible.ts": {
    category: "operator-configured",
    reason:
      "LLM_ALT_BASE_URL, validated by requireHttpsBase in llm/index.ts (an invalid value leaves the provider unconfigured)",
  },
  "supabase/functions/_shared/adapters/fetchers/direct.ts": {
    category: "ssrf-guarded",
    reason:
      "URLs from search results and documents: public host names only, DNS check, redirects re-validated, 2 MB cap",
    requires: ["publicUrlProblem", "readCapped"],
  },
  "supabase/functions/_shared/adapters/fetchers/jina.ts": {
    category: "ssrf-guarded",
    reason: "r.jina.ai receives a model-influenced target URL: checked with publicUrlProblem first",
    requires: ["publicUrlProblem"],
  },
  "supabase/functions/_shared/adapters/fetchers/edgar.ts": {
    category: "fixed-host",
    reason:
      "sec.gov and data.sec.gov paths built from CIK numbers and accession numbers from SEC responses",
  },
  "supabase/functions/_shared/adapters/flex.ts": {
    category: "fixed-host",
    reason:
      "FLEX_BASE_URL is a constant (ndcdyn.interactivebrokers.com), not an environment variable; the token travels in the query and URLs are never logged",
  },
};

export function fetchPolicyProblems(
  files: SourceFile[],
  policy: Record<string, FetchPolicy> = FETCH_POLICY,
): { problems: string[]; stale: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { file, text } of files) {
    const calls = findFetchCalls(file, text);
    if (calls.length === 0) continue;
    seen.add(file);
    const entry = policy[file];
    if (entry === undefined) {
      const first = calls[0] as Callsite;
      problems.push(
        `${file}:${first.line}: outbound fetch not reviewed (add it to FETCH_POLICY after checking where its URL comes from)`,
      );
      continue;
    }
    for (const needle of entry.requires ?? []) {
      if (!text.includes(needle))
        problems.push(
          `${file}: policy says ${entry.category} but the file no longer mentions ${needle}`,
        );
    }
  }
  const stale = Object.keys(policy)
    .filter((file) => !seen.has(file))
    .sort();
  return { problems, stale };
}
