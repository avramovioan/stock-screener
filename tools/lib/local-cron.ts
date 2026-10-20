// Pause the LOCAL stack's pg_cron jobs while a fixture suite runs: the real jobs (scan-catchup every 15 minutes between 07:00 and 11:59 UTC,
// tick-minute, broker-tick, retention and digest jobs) start scans and work that compete with the fixture scan ("scan did not finish").
import { spawnSync } from "node:child_process";
import { assertLocalStackUrl } from "./e2e-env.ts";
import { assertLocalUrl } from "./local-stack.ts";

/** The local database container (supabase project id `stock-screener`). */
export const LOCAL_DB_CONTAINER = "supabase_db_stock-screener";

/** The job list: every job that is active right now (a job somebody paused by hand stays paused). */
export const ACTIVE_JOBS_SQL = "select jobid from cron.job where active order by jobid";

/** Refuses anything but the local stack, with both of the tools' local-URL guards. */
export function assertLocalCronTarget(url: string, container: string = LOCAL_DB_CONTAINER): void {
  assertLocalUrl(url);
  assertLocalStackUrl(url);
  if (container !== LOCAL_DB_CONTAINER)
    throw new Error(`refusing to alter cron jobs in a non-local container: ${container}`);
}

/** Job ids from `psql -At` output (one id per line). */
export function parseJobIds(output: string): number[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      if (!/^\d+$/.test(l)) throw new Error(`unexpected cron job id: ${l}`);
      return Number(l);
    });
}

/** One `cron.alter_job` call per job. */
export function alterJobsSql(jobIds: number[], active: boolean): string {
  return jobIds.map((id) => `select cron.alter_job(${id}, active := ${active});`).join(" ");
}

function psql(sql: string): string {
  const r = spawnSync(
    "docker",
    ["exec", LOCAL_DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout;
}

/** Deactivates the active local cron jobs and returns the function that reactivates exactly those. Call it from a `finally`. */
export function pauseLocalCron(stackUrl: string): () => void {
  assertLocalCronTarget(stackUrl);
  const ids = parseJobIds(psql(ACTIVE_JOBS_SQL));
  if (ids.length > 0) psql(alterJobsSql(ids, false));
  console.log(`local cron: paused ${ids.length} job(s) for this run`);
  return () => {
    if (ids.length > 0) psql(alterJobsSql(ids, true));
    console.log(`local cron: reactivated ${ids.length} job(s)`);
  };
}
