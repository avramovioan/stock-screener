import type { Db } from "./db.ts";
import { fetchDocument } from "./fetchers/direct.ts";
import { createEdgarClient } from "./fetchers/edgar.ts";
import { readViaJina } from "./fetchers/jina.ts";
import { fetchFeed } from "./fetchers/rss.ts";
import { createFixtureFetch } from "./fixtures/fixture_fetch.ts";
import { createLlmChain } from "./llm/index.ts";
import type { FetchLike, LlmProvider } from "./llm/types.ts";
import { scanEvent } from "./log.ts";
import { createSupabaseResearchStore } from "./research_store.ts";
import {
  parseResearchSettings,
  type ResearchDeps,
  type ResearchSettings,
  type YahooNewsItem,
} from "./research_types.ts";
import { createTavilyClient } from "./search/tavily.ts";

export type Env = Record<string, string | undefined>;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hosts that mean "the local stack": the host itself, or the names the edge-runtime container reaches it by (`kong`, `host.docker.internal`). */
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal|kong)([:/]|$)/;

/**
 * Builds the research dependencies from function secrets. `fetchImpl` is injected by tests; `PROVIDER_MODE=fixture` (local stack
 * only: ALLOW_FIXTURE_PROVIDERS=1 and a local SUPABASE_URL) swaps in the fixture router, which answers recorded-shape responses for
 * known URLs and throws for anything else. Production passes nothing and every adapter uses the global `fetch`. Yahoo news is not created here: P1's rate-limited, breaker-guarded market
 * provider belongs to a run, so `registerP2` binds `yahooNews` per job from `HandlerContext.providers.market`.
 */
export function createResearchDeps(
  env: Env,
  db: Db,
  injectedFetch?: FetchLike,
  yahooNews?: (symbol: string) => Promise<YahooNewsItem[]>,
): ResearchDeps {
  let fetchImpl = injectedFetch;
  if (env["PROVIDER_MODE"] === "fixture") {
    if (env["ALLOW_FIXTURE_PROVIDERS"] !== "1" || !LOCAL_URL.test(env["SUPABASE_URL"] ?? ""))
      throw new Error(
        "PROVIDER_MODE=fixture is refused unless ALLOW_FIXTURE_PROVIDERS=1 and SUPABASE_URL is the local stack",
      );
    fetchImpl = createFixtureFetch();
  }
  const store = createSupabaseResearchStore(db.sb);
  // The chain lives in `app_settings.research.llm_chain`, which is read asynchronously: until `settings()` has loaded it the
  // providers are today's env pair. Every research and risk-check handler awaits `settings()` before it touches `llm`, which then
  // holds the owner's chain (the same objects are updated in place once).
  const llm: Record<string, LlmProvider> = {};
  const llmOrder: string[] = [];
  const useChain = (setting: unknown): void => {
    const chain = createLlmChain(setting, env, fetchImpl);
    for (const key of Object.keys(llm)) delete llm[key];
    Object.assign(llm, chain.byName);
    llmOrder.splice(0, llmOrder.length, ...chain.order);
  };
  useChain(undefined);
  const secUserAgent = env["SEC_USER_AGENT"] ?? "";
  let cached: ResearchSettings | null = null;
  return {
    store,
    llm,
    llmOrder,
    tavily: createTavilyClient({ apiKey: env["TAVILY_API_KEY"], fetchImpl }),
    fetch: {
      direct: (url, opts) => fetchDocument(url, { fetchImpl, ...opts }),
      jina: (url, opts) => readViaJina(url, { fetchImpl, ...opts }),
      feed: (url, opts) => fetchFeed(url, { fetchImpl, ...opts }),
    },
    edgar: createEdgarClient({ userAgent: secUserAgent, fetchImpl }),
    yahooNews:
      yahooNews ??
      (() => {
        throw new Error("yahoo news provider is not bound");
      }),
    async settings() {
      if (cached) return cached;
      const { data } = await db.sb
        .from("app_settings")
        .select("value")
        .eq("key", "research")
        .maybeSingle();
      cached = parseResearchSettings((data as { value: unknown } | null)?.value);
      useChain(cached.llm_chain);
      return cached;
    },
    now: () => new Date(),
    sha256: sha256Hex,
    log: async (event, data, ctx) => {
      await scanEvent(db, { runId: ctx?.scanRunId ?? null }, event, data ?? {}, {
        level: ctx?.level ?? "info",
        securityId: ctx?.securityId ?? null,
      });
    },
    secUserAgent,
    jinaApiKey: env["JINA_API_KEY"],
  };
}
