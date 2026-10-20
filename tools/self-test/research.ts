// biome-ignore-all lint/suspicious/noExplicitAny: PostgREST and function responses are untyped JSON
// Research integration scenario against the LOCAL stack (P2 Task 8). Run by `bun run test:integration` after the pipeline scenario;
// needs the functions served with PROVIDER_MODE=fixture (supabase/functions/.env), so Gemini, Tavily, Jina, EDGAR and company pages are
// answered by recorded-shape fixtures and an unknown URL fails the job instead of reaching the internet.
//
// It seeds a far-future scan run (2099-01-01, so the public view picks it up) that stays open on purpose (one queued `fx` job with a
// far-future not_before blocks stage seeding), enqueues research jobs itself, drives `worker-tick` over HTTP and asserts through the
// service client and the anonymous client. Everything it creates is deleted again.
import {
  assertLocalUrl,
  callFunction,
  createUser,
  deleteUser,
  resolveStack,
  rest,
  restAnon,
  restWrite,
  sleep,
} from "../lib/local-stack.ts";

const stack = resolveStack();
assertLocalUrl(stack.url);
const RUN_DATE = "2099-01-01";
const U = (n: number) => `00000000-0000-0000-0000-00000000a${String(n).padStart(3, "0")}`;
const ids = { grnc: U(1), rdco: U(2), hold: U(3) } as const;
const co = { grnc: U(11), rdco: U(12), hold: U(13) } as const;
const SECS = Object.values(ids).join(",");
const RESEARCH_SETTINGS = {
  min_recheck_hours: 72,
  ai_weekdays_only: false, // the self-test runs on the real clock: it must not depend on the weekday
  tavily_daily_cap: 32,
  tavily_monthly_budget: 950,
  llm_daily_request_cap: 300,
  max_change_checks_per_day: 40,
  reuse_days: 30,
  tavily_reserved_for_reports: 24,
};

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

const upsert = (table: string, onConflict: string, rows: unknown) =>
  restWrite(
    stack,
    "POST",
    `${table}?on_conflict=${onConflict}`,
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
const setResearch = (cap: number) =>
  upsert("app_settings", "key", {
    key: "research",
    value: { ...RESEARCH_SETTINGS, max_full_reports_per_day: cap },
  });

async function cleanup(runId: string | null, userId: string | null) {
  const secs = `in.(${SECS})`;
  await restWrite(stack, "DELETE", `todays_discounts?security_id=${secs}`);
  await restWrite(stack, "DELETE", `risk_findings?security_id=${secs}`);
  await restWrite(stack, "DELETE", `risk_monitor_state?security_id=${secs}`);
  await restWrite(stack, "DELETE", `research_reports?security_id=${secs}`);
  await restWrite(stack, "DELETE", `signal_episodes?security_id=${secs}`);
  if (runId !== null) {
    await restWrite(stack, "DELETE", `scan_jobs?scan_run_id=eq.${runId}`);
    await restWrite(stack, "DELETE", `scan_runs?id=eq.${runId}`);
  }
  await restWrite(stack, "DELETE", `scan_runs?scan_date_local=eq.${RUN_DATE}`);
  await restWrite(stack, "DELETE", `securities?id=${secs}`);
  await restWrite(stack, "DELETE", `companies?id=in.(${Object.values(co).join(",")})`);
  await restWrite(stack, "DELETE", "ai_quota_usage?resource=like.full_reports:*");
  if (userId !== null) await deleteUser(stack, userId);
}

async function seed(userId: string): Promise<string> {
  const defs = [
    ["grnc", "Greenfield Corp", "GRNC", "0000111111"],
    ["rdco", "Redline Holdings", "RDCO", "0000222222"],
    ["hold", "Holdfast Inc", "HOLD", "0000333333"],
  ] as const;
  for (const [k, name, sym, cik] of defs) {
    await upsert("companies", "id", {
      id: co[k],
      name,
      name_normalized: name.toLowerCase(),
      sec_cik: cik,
      sector: "Technology",
    });
    await upsert("securities", "id", {
      id: ids[k],
      company_id: co[k],
      yahoo_symbol: sym,
      exchange_code: "NMS",
      currency: "USD",
      currency_major: "USD",
      quote_type: "EQUITY",
      financial_currency: "USD",
      long_name: name,
      is_canonical: true,
      role: "canonical",
    });
  }
  // the settings snapshot of a real fixture run keeps loadRun, the fixture providers and every stage setting consistent
  const real = (
    await rest(
      stack,
      "scan_runs?select=settings_snapshot&status=eq.complete&order=scan_date_local.asc&limit=1",
    )
  )[0];
  if (!real) throw new Error("run the pipeline scenario first: no complete fixture scan run");
  const run = (
    await restWrite(
      stack,
      "POST",
      "scan_runs?on_conflict=scan_date_local",
      {
        scan_date_local: RUN_DATE,
        status: "running",
        trigger: "manual",
        settings_snapshot: real.settings_snapshot,
        results_published_at: new Date().toISOString(),
      },
      "resolution=merge-duplicates,return=representation",
    )
  )[0];
  const runId = run.id as string;
  // blocks stage seeding for the whole scenario: the run never completes on its own and the pipeline stages never start for it
  await restWrite(stack, "POST", "scan_jobs", {
    scan_run_id: runId,
    stage: "fx",
    key: "scenario-blocker",
    priority: 100,
    not_before: "2100-01-01T00:00:00Z",
    payload: {},
  });
  for (const k of ["grnc", "rdco"] as const) {
    const ep = (
      await restWrite(
        stack,
        "POST",
        "signal_episodes",
        {
          security_id: ids[k],
          company_id: co[k],
          kind: "discount",
          mode: "worldwide",
          threshold_line: "-3",
          opened_scan_run_id: runId,
          opened_session_date: "2098-12-31",
          opened_close: 10,
          opened_line_value: 12,
          open_reason: "new_entry",
          last_evaluated_session_date: "2098-12-31",
        },
        "return=representation",
      )
    )[0];
    await restWrite(stack, "POST", "todays_discounts", {
      scan_run_id: runId,
      mode: "worldwide",
      security_id: ids[k],
      company_id: co[k],
      episode_id: ep.id,
      is_new_episode: true,
      rank: k === "grnc" ? 5 : 6,
      close: 10,
      currency: "USD",
      session_date: "2098-12-31",
      threshold_line: "-3",
      lower_line_end: 12,
      channel: {},
      trend_ok: true,
      eligibility: {},
      operational_category: "pending",
      category_reason: "research_pending",
      data_freshness: "fresh",
      display_order: 0,
      withheld: true,
    });
  }
  await upsert("risk_monitor_state", "user_id,security_id", {
    user_id: userId,
    security_id: ids.hold,
    reasons: ["outside_top50"],
    last_seen_items: { seen: { edgar: ["0000333333-26-000001"] } },
    next_due_at: null,
  });
  return runId;
}

async function enqueue(
  runId: string,
  stage: string,
  key: string,
  payload: Record<string, unknown>,
  priority = 10,
) {
  await restWrite(
    stack,
    "POST",
    "scan_jobs?on_conflict=scan_run_id,stage,key",
    { scan_run_id: runId, stage, key, payload, priority },
    "resolution=ignore-duplicates,return=minimal",
  );
}

async function drain(runId: string, stages: string[], maxMs = 300_000) {
  const t0 = Date.now();
  let failures = 0;
  for (;;) {
    // the edge runtime can answer 502 for a worker that hit its CPU or wall-clock limit; the leases recover, so tick again
    try {
      await callFunction(stack, "worker-tick", { wait: true });
      failures = 0;
    } catch (e) {
      if (++failures > 3) throw e;
      await sleep(3000);
    }
    const open = await rest(
      stack,
      `scan_jobs?select=id,stage,key,status,last_error&scan_run_id=eq.${runId}&stage=in.(${stages.join(",")})&status=in.(queued,leased,failed)`,
    );
    if (open.length === 0) return;
    if (Date.now() - t0 > maxMs)
      throw new Error(
        `jobs did not drain (${stages.join(",")}): ${JSON.stringify(open.slice(0, 3))}`,
      );
    await sleep(1500);
  }
}

const reportsOf = (sids: string[]) =>
  rest(
    stack,
    `research_reports?select=id,security_id,status,trigger,is_current,error,conclusion,bankruptcy_risk,provider,model,prompt_version,schema_version,cited_evidence_ids,visibility&security_id=in.(${sids.join(",")})`,
  );
const cardOf = async (runId: string, sid: string): Promise<string> =>
  (
    await rest(
      stack,
      `todays_discounts?select=operational_category&scan_run_id=eq.${runId}&security_id=eq.${sid}`,
    )
  )[0].operational_category;

const email = `research-it-${crypto.randomUUID().slice(0, 8)}@example.test`;
const user = await createUser(stack, email, `Pw-${crypto.randomUUID()}`);
let runId: string | null = null;
try {
  await cleanup(null, null); // leftovers of an aborted earlier run
  runId = await seed(user.id);
  const run: string = runId;
  await restWrite(stack, "DELETE", "ai_quota_usage?id=gt.0"); // a clean day of quota: the pipeline scenario spent some
  const plan = (sid: string, trigger = "new_discount") => ({
    security_id: sid,
    trigger,
    scan_date_local: RUN_DATE,
  });

  // A. daily cap of one report: exactly one finishes, the other is deferred and its card stays pending (never cleared)
  await setResearch(1);
  for (const k of ["grnc", "rdco"] as const)
    await enqueue(run, "research", `research:${ids[k]}:new_discount:plan`, plan(ids[k]));
  await drain(run, ["research"]);
  const afterA = await reportsOf([ids.grnc, ids.rdco]);
  check(
    afterA.filter((r) => r.status === "complete").length === 1,
    "A: one report is complete under max_full_reports_per_day = 1",
  );
  const deferred = afterA.find((r) => r.status === "quota_deferred");
  check(
    deferred?.error === "daily_cap",
    "A: the other report is quota_deferred with reason daily_cap",
  );
  check(
    (await cardOf(run, deferred.security_id)) === "pending",
    "A: the deferred candidate's card stays pending",
  );

  // B. raise the cap and resume the deferred report the way the stage 10 seeder does
  await setResearch(4);
  await restWrite(stack, "PATCH", `research_reports?id=eq.${deferred.id}`, {
    not_before: new Date(Date.now() - 1000).toISOString(),
  });
  await enqueue(run, "research", `research:${deferred.id}:plan:resume:${RUN_DATE}`, {
    ...plan(deferred.security_id),
    report_id: deferred.id,
    step: "plan",
  });
  await drain(run, ["research"]);

  // C. monitored holding: the baseline holds the first filing, the fixture EDGAR submissions list a newer 8-K and 10-Q
  await enqueue(
    run,
    "research",
    `research:${ids.hold}:check`,
    { kind: "change_check", security_id: ids.hold, scan_date_local: RUN_DATE },
    50,
  );
  await drain(run, ["research"]);

  // D. final classification
  await enqueue(run, "classify", "classify:final", {}, 100);
  await drain(run, ["classify"]);

  const [grnc] = await rest(
    stack,
    `research_reports?select=*&security_id=eq.${ids.grnc}&trigger=eq.new_discount`,
  );
  const [rdco] = await rest(
    stack,
    `research_reports?select=*&security_id=eq.${ids.rdco}&trigger=eq.new_discount`,
  );
  check(
    grnc.status === "complete" && (await cardOf(run, ids.grnc)) === "green",
    "GRNC is complete and Green",
  );
  check(
    rdco.status === "complete" && (await cardOf(run, ids.rdco)) === "red",
    "RDCO is complete and Red (High bankruptcy risk)",
  );
  check(
    grnc.provider && grnc.model && grnc.prompt_version && grnc.schema_version,
    "provider, model, prompt_version and schema_version are persisted",
  );

  const sources = await rest(
    stack,
    `research_sources?select=evidence_id,verification,http_status,content_hash,retrieved_at,liveness_verified_at,used_in_report&report_id=eq.${grnc.id}`,
  );
  const cited = sources.filter((s) =>
    (grnc.cited_evidence_ids as number[]).includes(s.evidence_id),
  );
  check(
    cited.length > 0 &&
      cited.every(
        (s) =>
          s.verification === "ok" &&
          s.http_status === 200 &&
          s.retrieved_at &&
          s.liveness_verified_at &&
          s.used_in_report,
      ),
    "every cited source has liveness fields and is used_in_report",
  );

  const publicCards = await restAnon(
    stack,
    "v_todays_discounts?select=security_id,operational_category,withheld&mode=eq.worldwide",
  );
  check(
    publicCards.some((c) => c.security_id === ids.grnc && !c.withheld),
    "the Green candidate is a public card",
  );
  check(
    !publicCards.some((c) => c.security_id === ids.rdco && !c.withheld),
    "the Red candidate is absent from the public (not withheld) cards",
  );
  check(
    publicCards.some(
      (c) => c.security_id === ids.rdco && c.withheld && c.operational_category === "red",
    ),
    "the Red candidate is in the withheld set, marked red",
  );

  const findings = await rest(
    stack,
    `risk_findings?select=category,severity&user_id=eq.${user.id}&security_id=eq.${ids.hold}`,
  );
  check(
    findings.length === 1 && findings[0].category === "liquidity_debt",
    "HOLD: one liquidity_debt finding from the material 8-K",
  );
  const holdReports = await rest(
    stack,
    `research_reports?select=trigger,status,visibility&security_id=eq.${ids.hold}`,
  );
  check(
    holdReports.some((r) => r.trigger === "monitor_change" || r.trigger === "monitor_first"),
    "HOLD: a full holders-only report was queued by the change check",
  );
  check(
    holdReports.every((r) => r.visibility === "holders"),
    "HOLD: its reports are holders-only, never public",
  );

  // E. re-running creates no duplicate reports (idempotency key and reuse)
  const before = await reportsOf([ids.grnc, ids.rdco]);
  for (const k of ["grnc", "rdco"] as const)
    await enqueue(run, "research", `research:${ids[k]}:new_discount:plan:rerun`, plan(ids[k]));
  await enqueue(run, "research", `research:${ids.grnc}:manual:plan`, plan(ids.grnc, "manual"), 5);
  await enqueue(
    run,
    "research",
    `research:${ids.grnc}:manual:plan:again`,
    plan(ids.grnc, "manual"),
    5,
  );
  await drain(run, ["research"]);
  const after = await reportsOf([ids.grnc, ids.rdco]);
  check(
    after.length === before.length + 1 && after.filter((r) => r.trigger === "manual").length === 1,
    "re-running adds no duplicate report (one manual report for two manual requests)",
  );
  check(
    (await rest(stack, `research_reports?select=id&security_id=eq.${ids.grnc}&is_current=eq.true`))
      .length === 1,
    "exactly one current report per security",
  );
  console.log("research integration scenario passed");
} finally {
  await cleanup(runId, user.id);
}
