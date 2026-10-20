// biome-ignore-all lint/suspicious/noExplicitAny: recorded provider samples and PostgREST/function responses are untyped JSON
// Fixture-mode integration test of the whole pipeline against the LOCAL stack (spec 17.4). `bun run test:integration`.
// Prerequisites: `supabase start` (serves the functions), supabase/functions/.env with CRON_SHARED_SECRET and ALLOW_FIXTURE_PROVIDERS=1.
// It resets the database first (`--no-reset` skips that).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { assertLocalJwtIssuer } from "./lib/e2e-env.ts";
import { pauseLocalCron } from "./lib/local-cron.ts";
import {
  assertLocalUrl,
  callFunction,
  isTerminal,
  resolveStack,
  rest,
  restWrite,
  rpc,
  sleep,
} from "./lib/local-stack.ts";

assertLocalJwtIssuer(
  existsSync("supabase/functions/.env")
    ? readFileSync("supabase/functions/.env", "utf8")
    : undefined,
);
const stack = resolveStack();
assertLocalUrl(stack.url);
if (!process.argv.includes("--no-reset")) {
  const r = spawnSync("bunx", ["supabase", "db", "reset"], { stdio: "inherit", shell: true });
  assert.equal(r.status, 0, "supabase db reset failed");
  await sleep(8_000); // the edge runtime restarts with the database
}

// The real cron jobs (scan-catchup runs every 15 minutes from 07:00 to 11:59 UTC) would start scans that compete with the fixture scan.
const resumeCron = pauseLocalCron(stack.url);
try {
  // The first request after a restart can hit the edge runtime's cold-boot CPU limit; warm both functions up.
  for (const fn of ["worker-tick", "scan-control"]) {
    for (let i = 0; ; i++) {
      try {
        await callFunction(
          stack,
          fn,
          fn === "scan-control" ? { action: "status" } : { wait: true },
        );
        break;
      } catch (e) {
        if (i >= 5) throw e;
        await sleep(3_000);
      }
    }
  }

  async function runScan(
    set: string,
    now: string,
  ): Promise<{ id: string; status: string; created: boolean }> {
    const start = await callFunction(stack, "scan-control", {
      action: "start",
      provider_mode: "fixture",
      fixture_set: set,
      now,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    for (let i = 0; i < 40; i++) {
      await callFunction(stack, "worker-tick", { wait: true });
      const run = (
        await rest(stack, `scan_runs?select=id,status,finished_at&id=eq.${start.run}`)
      )[0];
      if (isTerminal(run)) return { id: run.id, status: run.status, created: start.created };
      await sleep(2_000);
    }
    throw new Error("scan did not finish");
  }
  const count = async (table: string, filter = ""): Promise<number> =>
    (await rest(stack, `${table}?select=id${filter}`)).length;

  // ---------------------------------------------------------------- P6 setup: put MSFT on the EUR watch list (it is not a card in the fixture world)
  // The watch list is the only way a non-card security such as MSFT gets resolved in the fixture world; it is also the operator's pre-resolve knob.
  await restWrite(stack, "PATCH", "app_settings?key=eq.eur_catalogue", {
    value: {
      enabled: true,
      require_shares: false,
      max_resolve_per_run: 40,
      extra_symbols: ["MSFT"],
    },
  });
  const countRows = async (table: string, column: string): Promise<number> =>
    (await rest(stack, `${table}?select=${column}`)).length;

  // ---------------------------------------------------------------- cadence setup: the weekend rule must not depend on the day the test runs
  // Fixture scans replay simulated dates but the research steps read the real clock: lift the weekdays-only rule (research.ai_weekdays_only)
  // so the whole pipeline runs on any day. The 72 hour rule and the weekend rule themselves are covered by the Deno and pgTAP suites.
  const researchSetting =
    (await rest(stack, "app_settings?select=value&key=eq.research"))[0]?.value ?? {};
  assert.equal(
    researchSetting.min_recheck_hours,
    72,
    "research.min_recheck_hours is seeded with 72",
  );
  assert.equal(
    researchSetting.ai_weekdays_only,
    true,
    "research.ai_weekdays_only is seeded with true",
  );
  await restWrite(stack, "PATCH", "app_settings?key=eq.research", {
    value: { ...researchSetting, ai_weekdays_only: false },
  });

  // ---------------------------------------------------------------- day 1: a full fixture scan
  const day1 = await runScan("day1", "2026-10-15T07:00:00Z");
  assert.equal(day1.status, "complete", "day 1 scan is complete");
  assert.equal(await count("scan_runs"), 1, "exactly one scan_runs row");
  const snaps = await rest(
    stack,
    `universe_snapshots?select=rank,mode,security_id&scan_run_id=eq.${day1.id}&mode=eq.worldwide&order=rank`,
  );
  assert.deepEqual(
    snaps.map((s) => s.rank),
    snaps.map((_, i) => i + 1),
    "ranks are 1..N and unique",
  );
  assert.equal(
    snaps.length,
    10,
    "12 listings form 10 companies (GOOG and MSF.DE merge into their companies)",
  );
  const cards = await rest(
    stack,
    `v_todays_discounts?select=yahoo_symbol,threshold_line,operational_category,withheld,close,line3_end,line4_end,reached_line4,is_top10,rank&mode=eq.worldwide`,
  );
  assert.deepEqual(
    cards.map((c) => c.yahoo_symbol).sort(),
    ["1299.HK", "9988.HK", "JPM"],
    "the three engineered securities are today's discounts in the worldwide universe",
  );
  const countries = await rest(
    stack,
    `v_todays_discounts?select=yahoo_symbol,country&mode=eq.worldwide&order=yahoo_symbol`,
  );
  assert.ok(
    countries.every((c) => typeof c.country === "string" && c.country.length > 0),
    "every card carries a country (company country, exchange country as the fallback)",
  );
  assert.equal(
    countries.find((c) => c.yahoo_symbol === "JPM")?.country,
    "United States",
    "JPM is shown as a United States company",
  );
  assert.ok(
    cards.every((c) => c.threshold_line === "-3"),
    "every discount episode opens on the -3 line (A-51)",
  );
  // A-51: the feed carries both line values and the tag inputs. 9988.HK and JPM sit below the -4 line, 1299.HK between the two lines.
  const cardOf = (symbol: string) => cards.find((c) => c.yahoo_symbol === symbol);
  assert.ok(
    cards.every(
      (c) =>
        typeof c.line3_end === "number" &&
        typeof c.line4_end === "number" &&
        c.line4_end < c.line3_end &&
        c.close <= c.line3_end,
    ),
    "every card has both line ends and closed at or below its -3 line",
  );
  assert.deepEqual(
    ["9988.HK", "JPM", "1299.HK"].map((s) => cardOf(s)?.reached_line4),
    [true, true, false],
    "reached_line4 is close <= the -4 line: true for the deep discounts, false between the lines",
  );
  assert.ok(
    cards.every((c) => c.is_top10 === c.rank <= 10),
    "is_top10 is the worldwide rank 1-10",
  );
  // On-demand research (design 2026-10-19, 5.1 and 6a): the daily scan researches no discount card. Without a report a card is pending with
  // category_reason not_requested; research starts only when a visitor asks through the public research-request function.
  assert.ok(
    cards.every((c) => c.operational_category === "pending"),
    "not researched: every card is pending after classify:final",
  );
  const cardReasons = await rest(
    stack,
    `todays_discounts?select=security_id,category_reason,securities(yahoo_symbol)&scan_run_id=eq.${day1.id}&mode=eq.worldwide`,
  );
  assert.equal(cardReasons.length, 3, "three discount cards in the run");
  assert.ok(
    cardReasons.every((c) => c.category_reason === "not_requested"),
    "every card says not_requested",
  );
  assert.equal(await count("research_reports"), 0, "the daily scan wrote no research report");
  const day1Coverage = (await rest(stack, `scan_runs?select=coverage&id=eq.${day1.id}`))[0].coverage
    .research;
  assert.equal(day1Coverage.required, 0, "research coverage: nothing was required");
  assert.equal(day1Coverage.cards, 3, "research coverage: all three cards counted");

  // Visitor path: ask for JPM through the public function (anon key, no JWT), drive the worker, then check the card.
  const jpmSecurityId = cardReasons.find((c) => c.securities?.yahoo_symbol === "JPM")?.security_id;
  assert.ok(jpmSecurityId, "JPM has a card");
  const requestResearch = async (securityId: string) => {
    const res = await fetch(`${stack.url}/functions/v1/research-request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: stack.anonKey,
        authorization: `Bearer ${stack.anonKey}`,
      },
      body: JSON.stringify({ security_id: securityId }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const accepted = await requestResearch(jpmSecurityId);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.ok, true, "research-request accepted the visitor request");
  const duplicate = await requestResearch(jpmSecurityId);
  assert.deepEqual(
    [duplicate.status, duplicate.body.reason],
    [409, "in_flight"],
    "a second request while the research runs answers 409 in_flight",
  );
  for (let i = 0; ; i++) {
    await callFunction(stack, "worker-tick", { wait: true });
    const r = (
      await rest(stack, `research_reports?select=status&security_id=eq.${jpmSecurityId}`)
    )[0];
    if (r?.status === "complete") break;
    if (i >= 40) throw new Error(`visitor research did not complete: ${JSON.stringify(r)}`);
    await sleep(2_000);
  }
  const again1 = await requestResearch(jpmSecurityId);
  assert.deepEqual(
    [again1.status, again1.body.reason],
    [429, "cooldown"],
    "a request after the report completed answers 429 cooldown",
  );
  const cardsAfter = await rest(
    stack,
    `v_todays_discounts?select=yahoo_symbol,operational_category,withheld&mode=eq.worldwide`,
  );
  const jpmAfter = cardsAfter.find((c) => c.yahoo_symbol === "JPM");
  // A fixture report is Green, so the requested card is published.
  assert.ok(
    jpmAfter?.operational_category === "green" && jpmAfter.withheld === false,
    "researched on request: JPM is Green and public",
  );
  assert.ok(
    cardsAfter
      .filter((c) => c.yahoo_symbol !== "JPM")
      .every((c) => c.operational_category === "pending"),
    "the other cards were not requested and stay pending",
  );
  const stillNotRequested = await rest(
    stack,
    `todays_discounts?select=category_reason,securities(yahoo_symbol)&scan_run_id=eq.${day1.id}&mode=eq.worldwide&security_id=neq.${jpmSecurityId}`,
  );
  assert.ok(
    stillNotRequested.length === 2 &&
      stillNotRequested.every((c) => c.category_reason === "not_requested"),
    "the other two cards are still not_requested",
  );
  const visitorReports = await rest(
    stack,
    "research_reports?select=trigger,usage_source:usage->>source&order=created_at",
  );
  assert.deepEqual(
    visitorReports,
    [{ trigger: "visitor", usage_source: "visitor" }],
    "exactly one report: trigger visitor and usage.source visitor",
  );

  const provenance = await rest(
    stack,
    `v_todays_discounts?select=yahoo_symbol,research_provider,research_model,research_completed_at,fallback_reason,wait_reason,last_attempt_at,next_attempt_at,next_provider&mode=eq.worldwide`,
  );
  assert.equal(provenance.length, 3, "three cards in the feed");
  assert.ok(
    provenance
      .filter((c) => c.yahoo_symbol === "JPM")
      .every(
        (c) =>
          typeof c.research_provider === "string" &&
          typeof c.research_model === "string" &&
          typeof c.research_completed_at === "string" &&
          c.fallback_reason === null &&
          c.wait_reason === null &&
          c.last_attempt_at === null &&
          c.next_attempt_at === null &&
          c.next_provider === null,
      ),
    "the researched card shows who wrote it and nothing waits (fallback_reason and the wait fields are null)",
  );
  assert.ok(
    provenance
      .filter((c) => c.yahoo_symbol !== "JPM")
      .every((c) => c.research_provider === null && c.research_completed_at === null),
    "unrequested cards carry no research provenance",
  );
  const cardResearch = await rest(
    stack,
    "v_card_research?select=research_provider,research_model,fallback_reason,wait_reason,next_provider&mode=eq.worldwide",
  );
  assert.ok(
    cardResearch.length === 3 &&
      cardResearch.filter((c) => typeof c.research_provider === "string").length === 1,
    "v_card_research carries the same provenance fields (one researched card)",
  );
  const scanStatus = await rpc(stack, "scan_status", {});
  assert.ok(
    "last_skipped" in scanStatus,
    "scan_status() reports last_skipped (null until a scan is skipped)",
  );
  const reports = await rest(
    stack,
    "research_reports?select=id,status,trigger,visibility,is_current,provider,model,prompt_version,schema_version,cited_evidence_ids,conclusion,bankruptcy_risk,limitations,error&order=created_at",
  );
  assert.equal(
    reports.length,
    1,
    "one research report: the requested card (JPM is a card in both modes)",
  );
  assert.ok(
    reports.every(
      (r) =>
        r.status === "complete" &&
        r.trigger === "visitor" &&
        r.visibility === "public" &&
        r.is_current === true &&
        r.error === null &&
        r.conclusion === "Meets these two fundamental checks." &&
        r.bankruptcy_risk === "Low",
    ),
    "the report is complete, current, public and Meets/Low",
  );
  assert.ok(
    reports.every((r) => r.provider && r.model && r.prompt_version && r.schema_version),
    "provider, model, prompt_version and schema_version are persisted",
  );
  const sources = await rest(
    stack,
    "research_sources?select=report_id,evidence_id,verification,http_status,content_hash,retrieved_at,liveness_verified_at,used_in_report",
  );
  for (const r of reports) {
    const cited = sources.filter(
      (x) => x.report_id === r.id && (r.cited_evidence_ids as number[]).includes(x.evidence_id),
    );
    assert.ok(
      cited.length > 0 &&
        cited.every(
          (x) =>
            x.verification === "ok" &&
            x.http_status === 200 &&
            x.retrieved_at !== null &&
            x.liveness_verified_at !== null &&
            x.used_in_report === true,
        ),
      "every cited source has liveness fields and is used_in_report",
    );
  }
  assert.deepEqual(
    await rest(stack, `scan_events?select=stage,event&scan_run_id=eq.${day1.id}&level=eq.error`),
    [],
    "no error events in the whole day-1 scan (research, EUR, digest and portfolio stages included)",
  );
  const canon = await rest(stack, `securities?select=yahoo_symbol,role&is_canonical=eq.true`);
  assert.ok(
    !canon.some((c) => c.yahoo_symbol === "GOOG" || c.yahoo_symbol === "MSF.DE"),
    "share classes and cross-listings are not canonical",
  );

  // ---------------------------------------------------------------- P6: weekly catalogue import and EUR equivalents (fixture providers, no IBKR, no Yahoo)
  const catalogue = await rest(
    stack,
    "ibkr_catalogue?select=exchange_id,local_symbol,conid&order=exchange_id,conid",
  );
  assert.deepEqual(
    catalogue.map((c) => `${c.exchange_id}:${c.local_symbol}`).sort(),
    ["AEB:ADYEN", "AEB:ASML", "AEB:MSFT", "AEB:UNA", "IBIS:APC", "IBIS:MSF", "IBIS:SAP"],
    "both exchanges were imported (EUR stocks only; ETF, USD and tracker rows are filtered out; AEB:MSFT is the synthetic look-alike)",
  );
  const importState = (await rest(stack, "app_settings?select=value&key=eq.eur_catalogue_state"))[0]
    .value;
  assert.equal(importState.last_result, "complete", "the import is recorded as complete");
  assert.equal(importState.last_success_week, "2026-W42", "for ISO week 2026-W42");
  const eurJobs = await rest(
    stack,
    `scan_jobs?select=stage,key,status&scan_run_id=eq.${day1.id}&stage=in.(eur_catalogue,eur_resolve)`,
  );
  assert.ok(
    eurJobs.length >= 2 && eurJobs.every((j) => j.status === "done"),
    "the EUR jobs finished without failing the scan",
  );
  assert.deepEqual(
    await rest(
      stack,
      `scan_events?select=event&scan_run_id=eq.${day1.id}&stage=in.(eur_catalogue,eur_resolve)&level=eq.error`,
    ),
    [],
    "no error events from the EUR stages",
  );

  const msft = (await rest(stack, "securities?select=id,isin&yahoo_symbol=eq.MSFT"))[0];
  assert.equal(
    msft.isin,
    "US5949181045",
    "the ISIN confirmed through Yahoo search is stored on the canonical security",
  );
  const msftRows = await rest(
    stack,
    `eur_equivalents?select=ibkr_exchange_id,ibkr_conid,ibkr_local_symbol,eur_symbol_yahoo,status,verified_at&security_id=eq.${msft.id}`,
  );
  assert.deepEqual(
    msftRows.map((r) => [
      r.ibkr_exchange_id,
      r.ibkr_local_symbol,
      r.ibkr_conid,
      r.eur_symbol_yahoo,
      r.status,
    ]),
    [["IBIS", "MSF", 12178239, "MSF.DE", "verified"]],
    "MSFT resolves to MSF.DE on IBIS, verified; the AEB look-alike with MSFT's ticker (a tracker ETP, MSFT.AS) is rejected and stored nowhere",
  );
  assert.ok(msftRows[0].verified_at !== null, "a verified line carries its verification time");

  const cardsEur = await rest(
    stack,
    "v_todays_discounts?select=yahoo_symbol,eur_status,eur_symbol_yahoo&mode=eq.worldwide&order=yahoo_symbol",
  );
  assert.deepEqual(
    cardsEur,
    [
      { yahoo_symbol: "1299.HK", eur_status: "none", eur_symbol_yahoo: null },
      { yahoo_symbol: "9988.HK", eur_status: "none", eur_symbol_yahoo: null },
      { yahoo_symbol: "JPM", eur_status: "none", eur_symbol_yahoo: null },
    ],
    "cards without a catalogue candidate say none (the UI shows No verified EUR equivalent), through the public view",
  );

  // ---------------------------------------------------------------- idempotency: start + tick again creates nothing
  const counts = async () => ({
    runs: await count("scan_runs"),
    results: await count("scan_security_results"),
    snaps: await count("universe_snapshots"),
    episodes: await count("signal_episodes"),
    cards: await count("todays_discounts"),
    reports: await count("research_reports"),
    sources: await count("research_sources"),
    eur: await count("eur_equivalents"),
    catalogue: await countRows("ibkr_catalogue", "conid"),
  });
  const before = await counts();
  const again = await callFunction(stack, "scan-control", {
    action: "start",
    provider_mode: "fixture",
    fixture_set: "day1",
    now: "2026-10-15T07:30:00Z",
  });
  assert.equal(again.created, false, "a second start for the same Sofia date creates no run");
  await callFunction(stack, "worker-tick", { wait: true });
  const after = await counts();
  assert.deepEqual(after, before, "row counts are unchanged after start + tick");

  // ---------------------------------------------------------------- public reads
  const page1 = await rpc(stack, "company_list", { p_mode: "worldwide" });
  assert.ok(page1.length <= 15 && page1.length === 10, "company_list returns at most 15 rows");
  const page2 = await rpc(stack, "company_list", {
    p_mode: "worldwide",
    p_limit: 25,
    p_after_rank: 5,
  });
  assert.deepEqual(
    page2.map((r: any) => r.rank),
    [6, 7, 8, 9, 10],
    "keyset pagination is stable",
  );
  const summary1 = await rpc(stack, "universe_summary", { p_mode: "worldwide" });
  assert.deepEqual(summary1.added_today, [], "the baseline run has no membership events");

  // ---------------------------------------------------------------- day 2: SHEL.L joins, 1299.HK moves from rank 10 to 11 (still a -3 discount: rank only changes its tag)
  const day2 = await runScan("day2", "2026-10-16T07:00:00Z");
  assert.equal(day2.status, "complete", "day 2 scan is complete");
  const summary2 = await rpc(stack, "universe_summary", { p_mode: "worldwide" });
  assert.equal(summary2.added_today.length, 1, "short summary detects the added company");
  const shell = await rest(
    stack,
    `securities?select=currency,currency_major&yahoo_symbol=eq.SHEL.L`,
  );
  assert.deepEqual(
    shell[0],
    { currency: "GBp", currency_major: "GBP" },
    "the minor-unit listing keeps GBp prices and GBP market cap",
  );
  const episodes = await rest(
    stack,
    `signal_episodes?select=status,threshold_line,close_reason,open_reason,notify,security_id&order=created_at`,
  );
  const hk1299 = (await rest(stack, `securities?select=id&yahoo_symbol=eq.1299.HK`))[0]?.id;
  assert.ok(hk1299, "1299.HK exists");
  assert.equal(
    episodes.filter((e) => e.security_id === hk1299 && e.close_reason === "threshold_changed")
      .length,
    0,
    "1299.HK's -3 episode is untouched when its rank crosses 10/11: rank never changes the trigger",
  );
  const hkCard2 = (
    await rest(
      stack,
      `v_todays_discounts?select=rank,is_top10,reached_line4,threshold_line&yahoo_symbol=eq.1299.HK&mode=eq.worldwide`,
    )
  )[0];
  assert.deepEqual(
    [hkCard2?.rank, hkCard2?.is_top10, hkCard2?.reached_line4, hkCard2?.threshold_line],
    [11, false, false, "-3"],
    "1299.HK is still a card on day 2, now rank 11: not the top 10 and not at its -4 line (tag: wait for the -4 line)",
  );
  assert.equal(
    episodes.filter(
      (e) => e.security_id === hk1299 && e.open_reason === "continuation" && e.notify === true,
    ).length,
    0,
    "a continuation never notifies: no notifying continuation episode for 1299.HK on day 2",
  );
  assert.equal(
    episodes.filter((e) => e.security_id === hk1299 && e.status === "active").length,
    1,
    "1299.HK has exactly one active discount episode",
  );
  const modes = await rest(
    stack,
    `scan_runs?select=id,provider_mode:settings_snapshot->>provider_mode`,
  );
  assert.equal(modes.length, 2, "two runs");
  assert.ok(
    modes.every((r) => r.provider_mode === "fixture"),
    "both runs were started in fixture provider mode",
  );
  assert.ok(
    episodes.some((e) => e.status === "active" && e.threshold_line === "-3"),
    "9988.HK's episode continues",
  );
  assert.equal(await count("scan_runs"), 2, "one run per local date");
  assert.equal(
    await count("research_reports"),
    1,
    "day 2 starts no research on its own: still only the visitor report",
  );

  // ---------------------------------------------------------------- P6: the next day of the same ISO week does not call the catalogue again
  const day2Import = (
    await rest(
      stack,
      `scan_jobs?select=status,result&stage=eq.eur_catalogue&scan_run_id=eq.${day2.id}`,
    )
  )[0];
  assert.equal(day2Import.status, "done");
  assert.equal(
    day2Import.result.reason,
    "already_imported_this_week",
    "weekly import: day 2 of week 42 is skipped",
  );
  assert.equal(
    await countRows("ibkr_catalogue", "conid"),
    7,
    "the catalogue was imported exactly once",
  );
  console.log("integration test passed");
} finally {
  resumeCron();
}
