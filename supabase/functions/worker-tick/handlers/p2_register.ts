import type { JobStage } from "../../_shared/adapters/log.ts";
import type { MonitorStore } from "../../_shared/adapters/monitor_store.ts";
import type {
  HandlerCtx,
  Job,
  NewJob,
  ResearchDeps,
  YahooNewsItem,
} from "../../_shared/adapters/research_types.ts";
import type { Handler, HandlerContext, Seeder, SeedPlan } from "../types.ts";
import { classifyFinalHandler, publishFinalHandler } from "./classify_final.ts";
import { newsHandler } from "./news.ts";
import { researchHandler } from "./research.ts";
import { planNewsStage, planResearchStage } from "./research_seed.ts";
import { riskCheckHandler, seedChecks } from "./risk_check.ts";

/** Stages P2 adds to the claim list of `worker-tick` (P1's PIPELINE_ORDER stays untouched). */
export const P2_STAGES: JobStage[] = ["news", "research"];

export interface P2Registration {
  handlers: { research: Handler; news: Handler };
  /** Wrap P1's `classify` / `publish` handlers: keys `classify:final` and `publish:final` are P2's, the rest stays P1's. */
  wrapClassify(p1: Handler): Handler;
  wrapPublish(p1: Handler): Handler;
  /**
   * `app.next_stage_to_seed` returns `classify` and `publish` twice (initial, then final). The wrapped seeder seeds the
   * `:final` key as soon as the `:initial` job of the run exists.
   */
  wrapSeeder(stage: "classify" | "publish", p1: Seeder): Seeder;
  seeders: { news: Seeder; research: Seeder };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value ?? null };

/** P1 hands handlers an epoch-ms deadline; the research steps measure time with `performance.now()`. */
const handlerCtx = (ctx: HandlerContext): HandlerCtx => ({
  signal: ctx.signal,
  deadline: performance.now() + (ctx.deadlineMs - Date.now()),
});

const jobOf = (ctx: HandlerContext): Job => ctx.job;

/** The P1 market provider of the run is rate limited and breaker guarded; Yahoo news goes through it. */
function yahooNewsOf(ctx: HandlerContext): (symbol: string) => Promise<YahooNewsItem[]> {
  return async (symbol) =>
    (await ctx.providers.market.news(symbol, 50)).map((n) => ({
      uuid: n.id,
      title: n.title,
      publisher: n.publisher ?? undefined,
      link: n.url,
      providerPublishTime: new Date(n.publishedMs),
      relatedTickers: n.relatedTickers,
    }));
}

const toPlan = (jobs: NewJob[]): SeedPlan => ({
  keys: jobs.map((j) => j.key),
  payloads: jobs.map((j) => j.payload),
  priorities: jobs.map((j) => j.priority ?? 100),
});

export function registerP2(deps: ResearchDeps, monitor?: MonitorStore): P2Registration {
  if (monitor) {
    deps.changeCheck = riskCheckHandler(deps, monitor);
    deps.seedExtras = seedChecks(deps, monitor);
  }
  const classifyFinal = classifyFinalHandler(deps);
  const publishFinal = publishFinalHandler(deps);
  return {
    handlers: {
      research: async (ctx) => {
        // The change check reads Yahoo news too, so it gets the run's provider like the news stage does.
        const bound: ResearchDeps = { ...deps, yahooNews: yahooNewsOf(ctx) };
        if (monitor) bound.changeCheck = riskCheckHandler(bound, monitor);
        return asRecord(await researchHandler(bound)(jobOf(ctx), handlerCtx(ctx)));
      },
      news: async (ctx) =>
        asRecord(
          await newsHandler({ ...deps, yahooNews: yahooNewsOf(ctx) })(jobOf(ctx), handlerCtx(ctx)),
        ),
    },
    wrapClassify: (p1) => async (ctx) =>
      ctx.job.key === "classify:final" ? asRecord(await classifyFinal(jobOf(ctx))) : await p1(ctx),
    wrapPublish: (p1) => async (ctx) =>
      ctx.job.key === "publish:final"
        ? asRecord(await publishFinal(jobOf(ctx), handlerCtx(ctx)))
        : await p1(ctx),
    wrapSeeder: (stage, p1) => async (ctx) => {
      const { count, error } = await ctx.db.sb
        .from("scan_jobs")
        .select("id", { count: "exact", head: true })
        .eq("scan_run_id", ctx.run.id)
        .eq("stage", stage)
        .eq("key", `${stage}:initial`);
      if (error) throw new Error(`scan_jobs.select: ${error.message}`);
      return (count ?? 0) > 0 ? { keys: [`${stage}:final`], priorities: [100] } : await p1(ctx);
    },
    seeders: {
      news: async (ctx) => toPlan(await planNewsStage(deps, ctx.run.id, ctx.run.scanDateLocal)),
      research: async (ctx) =>
        toPlan((await planResearchStage(deps, ctx.run.id, ctx.run.scanDateLocal)).jobs),
    },
  };
}

/** Merges P2 into the P1 registries: one call in `worker-tick/index.ts` (stages, handlers and seeders of a worker invocation). */
export function withP2(
  base: {
    stages: readonly JobStage[];
    handlers: Partial<Record<JobStage, Handler>>;
    seeders: Partial<Record<JobStage, Seeder>>;
  },
  p2: P2Registration,
): {
  stages: JobStage[];
  handlers: Partial<Record<JobStage, Handler>>;
  seeders: Partial<Record<JobStage, Seeder>>;
} {
  const { handlers, seeders } = base;
  const classify = handlers.classify;
  const publish = handlers.publish;
  const seedClassify = seeders.classify;
  const seedPublish = seeders.publish;
  return {
    stages: [...base.stages, ...P2_STAGES.filter((s) => !base.stages.includes(s))],
    handlers: {
      ...handlers,
      research: p2.handlers.research,
      news: p2.handlers.news,
      ...(classify ? { classify: p2.wrapClassify(classify) } : {}),
      ...(publish ? { publish: p2.wrapPublish(publish) } : {}),
    },
    seeders: {
      ...seeders,
      news: p2.seeders.news,
      research: p2.seeders.research,
      ...(seedClassify ? { classify: p2.wrapSeeder("classify", seedClassify) } : {}),
      ...(seedPublish ? { publish: p2.wrapSeeder("publish", seedPublish) } : {}),
    },
  };
}
