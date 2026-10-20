import type { Filing } from "../../_shared/adapters/fetchers/edgar.ts";
import type {
  HandlerCtx,
  Job,
  NewsItem,
  ResearchDeps,
} from "../../_shared/adapters/research_types.ts";
import { WATCH_FORMS } from "../../_shared/core/research.ts";
import { secTicker } from "./research_steps.ts";

const iso = (value: Date | string): string | null => {
  const t = typeof value === "string" ? Date.parse(value) : value.getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const newest = (a: NewsItem, b: NewsItem) =>
  (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");

export function newsHandler(deps: ResearchDeps) {
  return async (job: Job, ctx: HandlerCtx): Promise<unknown> => {
    const securityId = String(job.payload.security_id ?? "");
    const scanDate = String(job.payload.scan_date_local ?? "");
    const security = await deps.store.loadSecurity(securityId);
    if (!security) return { skipped: "unknown_security" };
    const where = { scanRunId: job.scan_run_id, securityId, level: "warn" as const };
    const symbol = secTicker(security);
    const ownSymbols = [security.ticker, security.newsSymbol].filter((s): s is string => !!s);

    let yahoo: NewsItem[] = [];
    if (symbol) {
      try {
        const raw = await deps.yahooNews(symbol);
        yahoo = raw
          .filter((i) =>
            (i.relatedTickers ?? []).some((t) => t === symbol || ownSymbols.includes(t)),
          )
          .map(
            (i): NewsItem => ({
              id: i.uuid,
              title: i.title,
              link: i.link,
              publishedAt: iso(i.providerPublishTime),
            }),
          )
          .sort(newest)
          .slice(0, 50);
      } catch (e) {
        await deps.log(
          "news_source_failed",
          { source: "yahoo", message: (e as Error).message.slice(0, 200) },
          where,
        );
      }
    }

    let cik = security.secCik;
    if (!cik && symbol) {
      const res = await deps.edgar.resolveCik(symbol);
      if (res.ok && res.value) {
        cik = res.value;
        await deps.store.saveSecCik(security.companyId, cik);
      }
    }
    let filings: Filing[] = [];
    if (cik) {
      const res = await deps.edgar.submissions(cik);
      if (res.ok) filings = res.value.filter((f) => WATCH_FORMS.includes(f.form)).slice(0, 30);
      else await deps.log("news_source_failed", { source: "edgar", kind: res.kind }, where);
    }
    const edgar: NewsItem[] = cik
      ? filings.map((f) => ({
          id: f.accession,
          title: `${f.form} filed ${f.filingDate}`,
          publishedAt: f.filingDate,
          form: f.form,
          link: deps.edgar.filingUrl(cik as string, f.accession, f.primaryDocument),
        }))
      : [];

    const rss: NewsItem[] = [];
    for (const url of security.irRssUrls.slice(0, 3)) {
      const res = await deps.fetch.feed(url, { signal: ctx.signal });
      if (!res.ok) {
        await deps.log("news_source_failed", { source: "rss", message: res.message }, where);
        continue;
      }
      for (const item of res.items.slice(0, 20)) {
        rss.push({
          id: item.guid,
          title: item.title,
          link: item.link,
          publishedAt: item.published,
        });
      }
    }
    rss.sort(newest);

    await deps.store.setLatestItems(securityId, { yahoo, edgar, rss: rss.slice(0, 50) });

    // the news stage only stores the items: research is started on request (spec 5.1), never here
    return { yahoo: yahoo.length, edgar: edgar.length, rss: rss.length };
  };
}
