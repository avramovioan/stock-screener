import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "../_shared/adapters/db.ts";
import { scanEvent } from "../_shared/adapters/log.ts";
import { createSupabaseResearchStore } from "../_shared/adapters/research_store.ts";
import type { TelegramResult } from "../_shared/adapters/telegram.ts";
import { scanDateLocal } from "../_shared/core/calendar.ts";
import { researchNow } from "./actions/research_now.ts";
import { telegramTest } from "./actions/telegram_probe.ts";
import { telegramSendLatest } from "./actions/telegram_send_latest.ts";
import type { Parsed } from "./validate.ts";

export interface Actor {
  via: "secret" | "jwt";
  userId: string | null;
}

export class ControlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

async function audit(
  sb: SupabaseClient,
  actor: Actor,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  const { error } = await sb.from("audit_events").insert({
    actor_id: actor.userId,
    action,
    target_type: targetType,
    target_id: targetId,
    details: { via: actor.via, ...details },
  });
  if (error) throw new ControlError(500, `audit_failed: ${error.message}`);
}

async function resolveRun(
  sb: SupabaseClient,
  run: string | null,
): Promise<{ id: string; scan_date_local: string; status: string } | null> {
  let q = sb.from("scan_runs").select("id, scan_date_local, status");
  if (run === null) q = q.order("scan_date_local", { ascending: false }).limit(1);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(run)) q = q.eq("scan_date_local", run);
  else q = q.eq("id", run);
  const { data, error } = await q.maybeSingle();
  if (error) throw new ControlError(500, error.message);
  return data as { id: string; scan_date_local: string; status: string } | null;
}

export async function execute(
  p: Extract<Parsed, { ok: true }>,
  deps: {
    db: Db;
    actor: Actor;
    allowFixtures: boolean;
    /** null when TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set */
    telegram: { send(text: string): Promise<TelegramResult> } | null;
  },
): Promise<Record<string, unknown>> {
  const { db, actor } = deps;
  const sb = db.sb;

  switch (p.action) {
    case "start": {
      if (p.providerMode === "fixture" && !deps.allowFixtures)
        throw new ControlError(403, "fixture_mode_not_allowed_here");
      const now = p.now ?? new Date().toISOString();
      const extra: Record<string, unknown> =
        p.providerMode === "fixture"
          ? { provider_mode: "fixture", fixture_set: p.fixtureSet ?? "day1" }
          : {};
      const id = await db.startDailyScan({
        now,
        force: true,
        trigger: "manual",
        snapshotExtra: extra,
      });
      if (id !== null) {
        await audit(sb, actor, "manual_scan_start", "scan_run", id, {
          provider_mode: p.providerMode,
          now,
        });
        return { created: true, run: id, scan_date_local: scanDateLocal(Date.parse(now)) };
      }
      const existing = await resolveRun(sb, scanDateLocal(Date.parse(now)));
      return {
        created: false,
        run: existing?.id ?? null,
        scan_date_local: scanDateLocal(Date.parse(now)),
        note: "a run already exists for this Sofia date; use requeue to retry its failed jobs",
      };
    }

    case "status": {
      const run = await resolveRun(sb, p.run);
      if (run === null) return { run: null };
      const { data: full } = await sb
        .from("scan_runs")
        .select(
          "id, scan_date_local, status, trigger, started_at, finished_at, coverage, universe_sizes, latest_session_date, results_published_at, list_published_at, settings_snapshot",
        )
        .eq("id", run.id)
        .single();
      const { data: jobs } = await sb
        .from("scan_jobs")
        .select("stage, status")
        .eq("scan_run_id", run.id)
        .limit(5000);
      const counts: Record<string, Record<string, number>> = {};
      for (const j of (jobs ?? []) as Array<{ stage: string; status: string }>) {
        const stage = counts[j.stage] ?? {};
        counts[j.stage] = stage;
        stage[j.status] = (stage[j.status] ?? 0) + 1;
      }
      const snapshot = ((full as { settings_snapshot: Record<string, unknown> } | null)
        ?.settings_snapshot ?? {}) as Record<string, unknown>;
      return {
        run: {
          ...(full as object),
          settings_snapshot: {
            provider_mode: snapshot["provider_mode"] ?? "live",
            fixture_set: snapshot["fixture_set"] ?? null,
          },
        },
        jobs: counts,
      };
    }

    case "requeue": {
      const run = await resolveRun(sb, p.run);
      if (run === null) throw new ControlError(404, "run_not_found");
      const { data, error } = await sb
        .from("scan_jobs")
        .update({
          status: "queued",
          attempts: 0,
          not_before: new Date().toISOString(),
          lease_until: null,
          leased_by: null,
          last_error: null,
          finished_at: null,
        })
        .eq("scan_run_id", run.id)
        .in("status", ["dead", "failed"])
        .select("id");
      if (error) throw new ControlError(500, error.message);
      await db.refreshScanStatus(run.id);
      await audit(sb, actor, "requeue", "scan_run", run.id, { jobs: data?.length ?? 0 });
      return { run: run.id, requeued: data?.length ?? 0 };
    }

    case "recompute": {
      const run = await resolveRun(sb, p.run);
      if (run === null) throw new ControlError(404, "run_not_found");
      // dropping the jobs of the derived stages makes app.next_stage_to_seed seed compute, rank_signals, classify and publish again
      const { data, error } = await sb
        .from("scan_jobs")
        .delete()
        .eq("scan_run_id", run.id)
        .in("stage", ["compute", "rank_signals", "classify", "publish"])
        .select("id");
      if (error) throw new ControlError(500, error.message);
      await sb.from("scan_runs").update({ finished_at: null }).eq("id", run.id);
      await db.refreshScanStatus(run.id);
      await audit(sb, actor, "recompute", "scan_run", run.id, { jobs_removed: data?.length ?? 0 });
      return { run: run.id, jobs_removed: data?.length ?? 0 };
    }

    case "list_failures": {
      const run = await resolveRun(sb, p.run);
      if (run === null) return { run: null, failures: [] };
      const { data: events } = await sb
        .from("scan_events")
        .select("at, stage, level, event, security_id, message, data")
        .eq("scan_run_id", run.id)
        .in("level", ["warn", "error"])
        .order("at", { ascending: false })
        .limit(200);
      const { data: dead } = await sb
        .from("scan_jobs")
        .select("stage, key, attempts, last_error, status")
        .eq("scan_run_id", run.id)
        .in("status", ["dead", "failed"]);
      return { run: run.id, dead_or_failed_jobs: dead ?? [], events: events ?? [] };
    }

    case "set_setting": {
      const { data: old } = await sb
        .from("app_settings")
        .select("value")
        .eq("key", p.key)
        .maybeSingle();
      const { error } = await sb.from("app_settings").upsert(
        {
          key: p.key,
          value: p.value as Record<string, unknown>,
          updated_by: actor.userId,
          is_public: p.key !== "pipeline" && p.key !== "providers",
        },
        { onConflict: "key" },
      );
      if (error) throw new ControlError(500, error.message);
      await audit(sb, actor, "set_setting", "app_setting", p.key, {
        old: old?.value ?? null,
        new: p.value,
        reason: p.reason,
      });
      return { key: p.key, updated: true };
    }

    case "override": {
      const { data, error } = await sb
        .from("security_identity_overrides")
        .insert({
          kind: p.kind,
          yahoo_symbol: p.yahooSymbol,
          target_company_id: p.targetCompanyId,
          payload: p.payload,
          reason: p.reason,
          created_by: actor.userId,
        })
        .select("id")
        .single();
      if (error) throw new ControlError(500, error.message);
      await audit(
        sb,
        actor,
        "override",
        "security_identity_override",
        (data as { id: string }).id,
        { kind: p.kind, yahoo_symbol: p.yahooSymbol, reason: p.reason },
      );
      await scanEvent(db, { runId: null }, "identity_override_added", {
        kind: p.kind,
        symbol: p.yahooSymbol,
      });
      return { id: (data as { id: string }).id };
    }

    case "telegram_test":
      return { ...(await telegramTest({ telegram: deps.telegram })) };

    case "telegram_send_latest":
      return { ...(await telegramSendLatest({ sb, configured: deps.telegram !== null })) };

    case "research_now": {
      // operator request (spec 7.12): one manual full report for a security, queued in the latest scan run
      const res = await researchNow(
        { store: createSupabaseResearchStore(sb) },
        { security_id: p.securityId, force: p.force },
      );
      if (!res.ok) throw new ControlError(res.error === "invalid_input" ? 400 : 404, res.error);
      if (res.job_key !== "")
        await audit(sb, actor, "research_now", "security", p.securityId, {
          job_key: res.job_key,
          scan_run_id: res.scan_run_id,
        });
      return {
        job_key: res.job_key,
        scan_run_id: res.scan_run_id,
        scan_date_local: res.scan_date_local,
        existing_report_id: res.existing_report_id,
      };
    }
  }
}
