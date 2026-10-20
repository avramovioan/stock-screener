import type { NewJob, ResearchDeps } from "../../_shared/adapters/research_types.ts";
import { TRIGGER_PRIORITY } from "./research_steps.ts";

type SeedDeps = Pick<ResearchDeps, "store" | "now" | "log" | "settings" | "seedExtras">;

/** Stage 9: one `news:<security_id>` job per pending card and per monitored holding. */
export async function planNewsStage(
  deps: SeedDeps,
  scanRunId: string,
  scanDateLocal: string,
): Promise<NewJob[]> {
  const targets = await deps.store.listNewsTargets(scanRunId);
  return targets.map((securityId) => ({
    scanRunId,
    stage: "news" as const,
    key: `news:${securityId}`,
    priority: 50,
    payload: { security_id: securityId, scan_run_id: scanRunId, scan_date_local: scanDateLocal },
  }));
}

export async function seedNewsStage(
  deps: SeedDeps,
  scanRunId: string,
  scanDateLocal: string,
): Promise<number> {
  const jobs = await planNewsStage(deps, scanRunId, scanDateLocal);
  for (const job of jobs) await deps.store.enqueueJob(job);
  return jobs.length;
}

/**
 * Stage 10 seeder. The scan researches nothing by itself any more: a card is researched when a visitor asks (`visitor`) or the
 * owner runs `research_now`. What remains is resuming deferred reports and the monitored-holdings checks, which
 * `seedExtras` enqueues itself (`monitor_first`, `monitor_change`) and counts.
 */
export async function planResearchStage(
  deps: SeedDeps,
  scanRunId: string,
  scanDateLocal: string,
): Promise<{ jobs: NewJob[]; extras: number }> {
  const { store } = deps;
  const now = deps.now();
  const jobs: NewJob[] = [];

  // Only monitored-holding reports are parked and resumed. A visitor or manual report the old worker parked during the deploy
  // window would never resume and would block new requests (the endpoint answers 409), so it is failed as `reset` first.
  const reset = await store.failStaleParkedReports();
  if (reset > 0) await deps.log("research_stale_parked_reset", { count: reset }, { scanRunId });
  const deferred = (await store.listDeferred(now.toISOString()))
    .filter((r) => r.trigger === "monitor_first" || r.trigger === "monitor_change")
    .sort((a, b) => TRIGGER_PRIORITY[a.trigger] - TRIGGER_PRIORITY[b.trigger]);
  for (const r of deferred) {
    const step = r.step ?? "plan";
    jobs.push({
      scanRunId,
      stage: "research",
      key: `research:${r.id}:${step}:resume:${scanDateLocal}`,
      priority: TRIGGER_PRIORITY[r.trigger],
      payload: {
        security_id: r.securityId,
        trigger: r.trigger,
        scan_date_local: scanDateLocal,
        report_id: r.id,
        step,
      },
    });
  }
  const extras = deps.seedExtras ? await deps.seedExtras(scanRunId, scanDateLocal) : 0;
  return { jobs, extras };
}

export async function seedResearchStage(
  deps: SeedDeps,
  scanRunId: string,
  scanDateLocal: string,
): Promise<number> {
  const { jobs, extras } = await planResearchStage(deps, scanRunId, scanDateLocal);
  for (const job of jobs) await deps.store.enqueueJob(job);
  const count = jobs.length + extras;
  await deps.log("stage_seeded", { stage: "research", jobs: count }, { scanRunId });
  return count;
}
