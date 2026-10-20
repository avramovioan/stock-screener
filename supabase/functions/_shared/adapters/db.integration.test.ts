// Opt-in: talks to the LOCAL stack. DB_INTEGRATION=1 SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<service key from `supabase status -o json`>
// deno test --config supabase/functions/deno.json --allow-net=127.0.0.1,localhost --allow-env <this file>
import { assert, assertEquals } from "@std/assert";
import { createDb, createQuoteCacheKv, createServiceClient } from "./db.ts";

const enabled = Deno.env.get("DB_INTEGRATION") === "1";

Deno.test(
  { name: "db helpers: every rpc argument convention works through PostgREST", ignore: !enabled },
  async () => {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    assert(
      url.includes("127.0.0.1") || url.includes("localhost"),
      "refusing to run against a non-local stack",
    );
    const sb = createServiceClient();
    const db = createDb(sb);
    const runIds: string[] = [];
    try {
      // a forced start on a far-future date so it cannot collide with real data
      const run = await db.startDailyScan({
        now: "2031-05-05T05:00:00Z",
        force: true,
        trigger: "manual",
        snapshotExtra: { provider_mode: "fixture" },
      });
      assert(run !== null);
      runIds.push(run);
      assertEquals(
        await db.startDailyScan({ now: "2031-05-05T05:30:00Z", force: true, trigger: "manual" }),
        null,
        "a second start for the same Sofia date is null",
      );

      const claimed = await db.claimJobs({
        worker: "it-worker",
        limit: 3,
        leaseSeconds: 180,
        stages: ["fx"],
        stageLimits: { fx: 1 },
      });
      const mine = claimed.filter((j) => j.scan_run_id === run);
      assertEquals(mine.length, 1);
      assertEquals(
        [mine[0]!.stage, mine[0]!.key, mine[0]!.attempts, mine[0]!.leased_by],
        ["fx", "all", 1, "it-worker"],
      );

      await db.completeJob(mine[0]!.id, { rates: 3 });
      assertEquals(await db.nextStageToSeed(run), "universe_sweep");
      assertEquals(
        await db.seedStage({
          run,
          stage: "universe_sweep",
          keys: ["NMS", "GER"],
          payloads: [{ n: 1 }, { n: 2 }],
          priorities: [20, 10],
        }),
        2,
      );
      assertEquals(
        await db.seedStage({ run, stage: "universe_sweep", keys: ["NMS", "GER"] }),
        0,
        "idempotent",
      );

      const sweep = (
        await db.claimJobs({
          worker: "it-worker",
          limit: 5,
          leaseSeconds: 60,
          stages: ["universe_sweep"],
          stageLimits: {},
        })
      ).filter((j) => j.scan_run_id === run);
      assertEquals(
        sweep.map((j) => j.key),
        ["GER", "NMS"],
        "priority order, payloads aligned",
      );
      assertEquals(sweep[0]!.payload, { n: 2 });

      assertEquals(
        await db.failJob({
          id: sweep[0]!.id,
          error: "boom api_key=SECRET",
          worker: "other-worker",
        }),
        null,
        "a job leased by another worker is not touched",
      );
      assertEquals(
        await db.failJob({ id: sweep[0]!.id, error: "boom api_key=SECRET", worker: "it-worker" }),
        "failed",
      );
      await db.deferJob(sweep[1]!.id, 30, "breaker_open");
      assertEquals(await db.failJob({ id: sweep[0]!.id, error: "fatal", fatal: true }), "dead");
      await db.heartbeatJob(sweep[1]!.id, 60); // not leased any more: a no-op, not an error

      assertEquals(await db.refreshScanStatus(run), "running");
      await db.recordEvent({
        runId: run,
        jobId: null,
        stage: "fx",
        level: "info",
        event: "it_event",
        securityId: null,
        message: "hello",
        data: { a: 1 },
      });
      const ev = await sb
        .from("scan_events")
        .select("event, data, stage")
        .eq("scan_run_id", run)
        .eq("event", "it_event");
      assertEquals(ev.data?.length, 1);
      assertEquals(ev.data?.[0]?.stage, "fx");

      const kv = createQuoteCacheKv(sb);
      await kv.set("it:key", { crumb: "x" }, 60_000);
      assertEquals(await kv.get("it:key"), { crumb: "x" });
      await kv.set("it:expired", { a: 1 }, -1000);
      assertEquals(await kv.get("it:expired"), null);
      await kv.delete("it:key");
      assertEquals(await kv.get("it:key"), null);
      await kv.delete("it:expired");

      assert(typeof (await db.purgeExpired())["scan_events"] === "number");
    } finally {
      for (const id of runIds) await sb.from("scan_runs").delete().eq("id", id); // cascades to scan_jobs
    }
  },
);
