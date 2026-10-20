import type { FetchLike } from "../llm/types.ts";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string | undefined;
}

export type TavilyResult =
  | { ok: true; results: SearchHit[] }
  | {
      ok: false;
      kind: "quota" | "rate_limited" | "http" | "network" | "not_configured";
      status?: number | undefined;
      message: string;
    };

export interface TavilyClient {
  /** False when no API key is set; callers check it before reserving quota. */
  readonly configured?: boolean;
  search(query: string, signal?: AbortSignal): Promise<TavilyResult>;
}

export interface TavilyOptions {
  apiKey?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

/** One basic-depth search (1 credit). 429 is a rate limit; 432 and 433 are Tavily's plan and pay-as-you-go limits. */
export function createTavilyClient(opts: TavilyOptions): TavilyClient {
  const apiKey = opts.apiKey?.trim() ?? "";
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    configured: apiKey !== "",
    async search(query, signal) {
      if (apiKey === "")
        return { ok: false, kind: "not_configured", message: "TAVILY_API_KEY is not set" };
      let res: Response;
      try {
        res = await doFetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: "basic",
            max_results: 5,
            include_answer: false,
          }),
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e))
          .split(apiKey)
          .join("[redacted]")
          .slice(0, 200);
        return { ok: false, kind: "network", message };
      }
      if (res.status === 429) {
        await res.body?.cancel();
        return { ok: false, kind: "rate_limited", status: 429, message: "Tavily rate limit" };
      }
      if (res.status === 432 || res.status === 433) {
        await res.body?.cancel();
        return {
          ok: false,
          kind: "quota",
          status: res.status,
          message: "Tavily usage limit exceeded",
        };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return {
          ok: false,
          kind: "http",
          status: res.status,
          message: `Tavily HTTP ${res.status}`,
        };
      }
      let body: { results?: Record<string, unknown>[] };
      try {
        body = (await res.json()) as { results?: Record<string, unknown>[] };
      } catch {
        return {
          ok: false,
          kind: "http",
          status: res.status,
          message: "Tavily returned invalid JSON",
        };
      }
      const results: SearchHit[] = [];
      for (const r of body.results ?? []) {
        const url = typeof r.url === "string" ? r.url : "";
        if (url === "") continue;
        const published =
          typeof r.published_date === "string"
            ? r.published_date
            : typeof r.publishedDate === "string"
              ? r.publishedDate
              : undefined;
        results.push({
          url,
          title: typeof r.title === "string" ? r.title : url,
          snippet: typeof r.content === "string" ? r.content.slice(0, 500) : "",
          ...(published ? { publishedDate: published } : {}),
        });
      }
      return { ok: true, results };
    },
  };
}
