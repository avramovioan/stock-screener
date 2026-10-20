import { POLL_DELAYS_S } from "@core/flex-errors.ts";
import { assert, assertEquals } from "@std/assert";
import { advanceRun, processStatement, runUntilSettled, workerTick } from "./machine.ts";
import {
  CONN,
  FakeFlex,
  FIXTURE_XML,
  flexFail,
  makeRig,
  newRun,
  SEND_OK,
  STATEMENT_OK,
  TOKEN,
  USER,
} from "./testing.ts";

const at = (rig: { clock: { t: number } }, iso: string | null) =>
  iso === null ? null : Date.parse(iso) - rig.clock.t;

Deno.test("verify happy path: queued -> requested -> done, linked, backfill queued, never logs the token", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  let run = await newRun(rig);
  run = await advanceRun(rig.deps, run);
  assertEquals(
    [run.state, run.reference_code, at(rig, run.next_poll_at)],
    ["requested", "1234567890", 5000],
  );
  assertEquals(rig.flex.calls[0], { kind: "send", token: TOKEN, arg: "123456", period: undefined });

  rig.clock.t += 5000;
  run = await advanceRun(rig.deps, run);
  assertEquals(run.state, "done");
  assertEquals(rig.store.ingests.length, 1);
  assertEquals(rig.matched, [USER]);
  assertEquals(rig.riskRefreshed, [USER]);
  assertEquals((run.rows_summary as { positions: number }).positions, 2);
  const conn = await rig.store.getConnectionById(CONN);
  assertEquals(conn?.status, "linked");
  assert(conn?.linked_at !== null && conn?.last_verified_at !== null);
  const backfill = [...rig.store.runs.values()].find((r) => r.kind === "backfill");
  assertEquals([backfill?.state, backfill?.statement_from], ["queued", null]);
  assert(rig.store.audits.some((a) => a.eventType === "broker.test" && a.data["result"] === "ok"));
  assert(!JSON.stringify(rig.logs).includes(TOKEN));
  assert(!JSON.stringify(rig.store.audits).includes(TOKEN));
});

Deno.test("a second verify of an already linked connection queues no second backfill", async () => {
  const rig = await makeRig({
    flex: new FakeFlex([SEND_OK, SEND_OK], [STATEMENT_OK, STATEMENT_OK]),
  });
  for (let i = 0; i < 2; i++) {
    let run = await newRun(rig);
    run = await advanceRun(rig.deps, run);
    run = await advanceRun(rig.deps, run);
    assertEquals(run.state, "done");
    for (const r of rig.store.runs.values())
      if (r.kind === "backfill") rig.store.runs.set(r.id, { ...r, state: "done" });
  }
  assertEquals([...rig.store.runs.values()].filter((r) => r.kind === "backfill").length, 1);
});

Deno.test("daily and backfill runs choose the period: explicit fd/td, or p=365", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK, SEND_OK], []) });
  const daily = await newRun(rig, "daily", { from: "2026-10-09", to: "2026-10-14" });
  await advanceRun(rig.deps, daily);
  rig.store.runs.set(daily.id, {
    ...(rig.store.runs.get(daily.id) as typeof daily),
    state: "done",
  });
  const backfill = await newRun(rig, "backfill");
  await advanceRun(rig.deps, backfill);
  assertEquals(rig.flex.calls[0]?.period, { from: "2026-10-09", to: "2026-10-14" });
  assertEquals(rig.flex.calls[1]?.period, { days: 365 });
});

Deno.test("1019 loop: polls are counted, delays follow the budget, then the statement arrives", async () => {
  const rig = await makeRig({
    flex: new FakeFlex([SEND_OK], [flexFail(1019), flexFail(1019), flexFail(1019), STATEMENT_OK]),
  });
  let run = await advanceRun(rig.deps, await newRun(rig));
  const delays: Array<number | null> = [];
  const polls: number[] = [];
  for (let i = 0; i < 3; i++) {
    rig.clock.t = Date.parse(run.next_poll_at as string);
    run = await advanceRun(rig.deps, run);
    assertEquals(run.state, "polling");
    polls.push(run.poll_count);
    delays.push(at(rig, run.next_poll_at));
  }
  assertEquals(polls, [1, 2, 3]);
  assertEquals(
    delays,
    [POLL_DELAYS_S[0], POLL_DELAYS_S[1], POLL_DELAYS_S[2]].map((s) => (s as number) * 1000),
  );
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals(run.state, "done");
});

Deno.test("the tenth failed poll ends the run with the poll-limit code", async () => {
  const rig = await makeRig({
    flex: new FakeFlex(
      [SEND_OK],
      Array.from({ length: 12 }, () => flexFail(1019)),
    ),
  });
  let run = await advanceRun(rig.deps, await newRun(rig));
  let polls = 0;
  while (run.state === "requested" || run.state === "polling") {
    rig.clock.t = Date.parse(run.next_poll_at as string);
    run = await advanceRun(rig.deps, run);
    polls += 1;
  }
  assertEquals([run.state, run.error_code, polls], ["failed", -4, 10]);
  assertEquals((await rig.store.getConnectionById(CONN))?.last_error_code, -4);
});

Deno.test("1018 never counts as a poll and waits a minute", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [flexFail(1018), STATEMENT_OK]) });
  let run = await advanceRun(rig.deps, await newRun(rig));
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals([run.state, run.poll_count, at(rig, run.next_poll_at)], ["polling", 0, 60_000]);
});

Deno.test("1012 expires the run and the connection; credential errors put the connection in error", async () => {
  const expired = await makeRig({ flex: new FakeFlex([flexFail(1012)]) });
  let run = await advanceRun(expired.deps, await newRun(expired));
  assertEquals(
    [run.state, run.error_code, (await expired.store.getConnectionById(CONN))?.status],
    ["expired", 1012, "expired"],
  );
  for (const code of [1015, 1013, 1014, 1011, 1010]) {
    const rig = await makeRig({ flex: new FakeFlex([flexFail(code)]) });
    run = await advanceRun(rig.deps, await newRun(rig));
    const conn = await rig.store.getConnectionById(CONN);
    assertEquals(
      [run.state, run.error_code, conn?.status, conn?.last_error_code],
      ["failed", code, "error", code],
    );
  }
});

Deno.test("1017 restarts the request once and then fails", async () => {
  const rig = await makeRig({
    flex: new FakeFlex([SEND_OK, SEND_OK], [flexFail(1017), flexFail(1017)]),
  });
  let run = await advanceRun(rig.deps, await newRun(rig));
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals(
    [run.state, run.reference_code, run.rows_summary["restarted"]],
    ["queued", null, true],
  );
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals(run.state, "requested");
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals([run.state, run.error_code], ["failed", 1017]);
});

Deno.test("a retryable send error keeps the run queued and gives up after five sends", async () => {
  const rig = await makeRig({
    flex: new FakeFlex(Array.from({ length: 6 }, () => flexFail(1018))),
  });
  let run = await newRun(rig);
  for (let i = 0; i < 4; i++) {
    run = await advanceRun(rig.deps, run);
    assertEquals([run.state, at(rig, run.next_poll_at)], ["queued", 60_000]);
    rig.clock.t = Date.parse(run.next_poll_at as string);
  }
  run = await advanceRun(rig.deps, run);
  assertEquals([run.state, run.error_code], ["failed", -5]);
});

Deno.test("unknown codes are retried twice and then fatal", async () => {
  const rig = await makeRig({
    flex: new FakeFlex([SEND_OK], [flexFail(1999), flexFail(1999), flexFail(1999)]),
  });
  let run = await advanceRun(rig.deps, await newRun(rig));
  for (const expected of ["polling", "polling", "failed"]) {
    rig.clock.t = Date.parse((run.next_poll_at ?? new Date(rig.clock.t).toISOString()) as string);
    run = await advanceRun(rig.deps, run);
    assertEquals(run.state, expected);
  }
  assertEquals(run.error_code, 1999);
});

Deno.test("a key that can no longer be opened fails the run with -2 and makes NO Flex call (rotated key)", async () => {
  const rig = await makeRig();
  rig.env.delete("FLEX_ENC_KEY_V1");
  rig.env.set("FLEX_ENC_KEY_V2", btoa("0123456789abcdef0123456789abcdef"));
  rig.env.set("FLEX_ENC_KEY_CURRENT", "2");
  const run = await advanceRun(rig.deps, await newRun(rig));
  const conn = await rig.store.getConnectionById(CONN);
  assertEquals(
    [run.state, run.error_code, conn?.status, conn?.last_error_code],
    ["failed", -2, "error", -2],
  );
  assertEquals(rig.flex.calls.length, 0);
});

Deno.test("a parse error writes nothing and keeps the previous data (code -1)", async () => {
  const rig = await makeRig();
  const run = await newRun(rig, "daily");
  const conn = (await rig.store.getConnectionById(CONN)) as NonNullable<
    Awaited<ReturnType<typeof rig.store.getConnectionById>>
  >;
  const out = await processStatement(rig.deps, run, conn, "<FlexQueryResponse><FlexStatements>");
  assertEquals([out.state, out.error_code], ["failed", -1]);
  assertEquals(rig.store.ingests.length, 0);
  // a failed daily statement leaves the connection status alone (only the error fields change)
  const after = await rig.store.getConnectionById(CONN);
  assertEquals([after?.status, after?.last_error_code], ["linking", -1]);
});

Deno.test("a statement without a required section or field is rejected with the checklist (code -6)", async () => {
  const rig = await makeRig();
  const run = await newRun(rig, "verify");
  const conn = (await rig.store.getConnectionById(CONN)) as NonNullable<
    Awaited<ReturnType<typeof rig.store.getConnectionById>>
  >;
  const out = await processStatement(
    rig.deps,
    run,
    conn,
    FIXTURE_XML.replace(/<CashTransactions>[\s\S]*<\/CashTransactions>/, ""),
  );
  assertEquals([out.state, out.error_code], ["failed", -6]);
  const sections = out.rows_summary["sections"] as Array<{ section: string; present: boolean }>;
  assertEquals(sections.find((s) => s.section === "Cash Transactions")?.present, false);
  assertEquals(rig.store.ingests.length, 0);
  assertEquals((await rig.store.getConnectionById(CONN))?.status, "error");
});

Deno.test("a statement of another account fails a daily run (-3) but a verify run may switch accounts after deleting the old data", async () => {
  const rig = await makeRig();
  await rig.store.patchConnection(CONN, {
    status: "linked",
    account_id_masked: "U***9999",
    linked_at: "2026-10-01T00:00:00Z",
  });
  const conn = (await rig.store.getConnectionById(CONN)) as NonNullable<
    Awaited<ReturnType<typeof rig.store.getConnectionById>>
  >;
  const daily = await processStatement(rig.deps, await newRun(rig, "daily"), conn, FIXTURE_XML);
  assertEquals([daily.state, daily.error_code], ["failed", -3]);
  assertEquals(rig.store.ingests.length, 0);
  rig.store.runs.set(daily.id, { ...daily, state: "done" });

  const verify = await processStatement(rig.deps, await newRun(rig, "verify"), conn, FIXTURE_XML);
  assertEquals(verify.state, "done");
  assertEquals(rig.store.deleted, [{ userId: USER, includeRuns: false }]);
  assertEquals(rig.store.ingests.length, 1);
});

Deno.test("matching and risk-set failures never fail the sync", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  rig.deps.matcher.matchUserPositions = () => Promise.reject(new Error("yahoo down"));
  rig.deps.riskSet.refresh = () => Promise.reject(new Error("db down"));
  let run = await advanceRun(rig.deps, await newRun(rig));
  run = await advanceRun(rig.deps, run);
  assertEquals(run.state, "done");
  assertEquals(run.rows_summary["match_error"], true);
});

Deno.test("runUntilSettled waits inline, hands a long poll over to the tick, and never exceeds its budget", async () => {
  const quick = await makeRig({ flex: new FakeFlex([SEND_OK], [flexFail(1019), STATEMENT_OK]) });
  const done = await runUntilSettled(quick.deps, (await newRun(quick)).id, 60_000);
  assertEquals(done?.state, "done");
  assertEquals(quick.clock.sleeps, [5000, 15_000]);

  const slow = await makeRig({
    flex: new FakeFlex(
      [SEND_OK],
      Array.from({ length: 12 }, () => flexFail(1019)),
    ),
  });
  const start = slow.clock.t;
  const handedOver = await runUntilSettled(slow.deps, (await newRun(slow)).id, 60_000);
  assertEquals(handedOver?.state, "polling");
  assert(slow.clock.t - start <= 60_000);
  assertEquals(slow.store.leased.has(handedOver?.id ?? ""), false);
});

Deno.test("runUntilSettled does nothing when another worker holds the lease", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK]) });
  const run = await newRun(rig);
  rig.store.leased.add(run.id);
  const out = await runUntilSettled(rig.deps, run.id, 60_000);
  assertEquals(out?.state, "queued");
  assertEquals(rig.flex.calls.length, 0);
});

Deno.test("the tick advances due runs, skips runs that are not due, and counts crashes (third crash ends the run)", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  const run = await newRun(rig, "daily");
  assertEquals((await workerTick(rig.deps, 10_000)).processed, 1);
  assertEquals(rig.store.runs.get(run.id)?.state, "requested");
  assertEquals((await workerTick(rig.deps, 10_000)).processed, 0);
  rig.clock.t += 6000;
  assertEquals((await workerTick(rig.deps, 10_000)).processed, 1);
  assertEquals(rig.store.runs.get(run.id)?.state, "done");

  const crashy = await makeRig({
    flex: new FakeFlex([SEND_OK], [STATEMENT_OK, STATEMENT_OK, STATEMENT_OK]),
  });
  const c = await newRun(crashy, "daily");
  await advanceRun(crashy.deps, c).then((r) => crashy.store.runs.set(r.id, r));
  crashy.store.failIngest = true;
  for (let i = 0; i < 3; i++) {
    crashy.clock.t += 120_000;
    crashy.store.leased.clear();
    await workerTick(crashy.deps, 10_000);
  }
  assertEquals(
    [crashy.store.runs.get(c.id)?.state, crashy.store.runs.get(c.id)?.error_code],
    ["failed", -7],
  );
  assert(crashy.logs.some((l) => l.event === "run_crashed"));
  assert(!JSON.stringify(crashy.logs).includes("db down"));
});

Deno.test("a run whose connection was unlinked ends without any Flex call", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK]) });
  const run = await newRun(rig);
  await rig.store.zeroToken(CONN);
  const out = await advanceRun(rig.deps, run);
  assertEquals([out.state, out.error_code, rig.flex.calls.length], ["failed", -7, 0]);
});

Deno.test("persistent 1018 while polling fails the run after five throttles instead of looping forever", async () => {
  const rig = await makeRig({
    flex: new FakeFlex(
      [SEND_OK],
      Array.from({ length: 12 }, () => flexFail(1018)),
    ),
  });
  let run = await advanceRun(rig.deps, await newRun(rig));
  let steps = 0;
  while (run.state === "requested" || run.state === "polling") {
    rig.clock.t = Date.parse(run.next_poll_at as string);
    run = await advanceRun(rig.deps, run);
    steps += 1;
  }
  assertEquals([run.state, run.error_code, steps, run.poll_count], ["failed", -5, 5, 0]);
  assertEquals(run.rows_summary["rate_limited"], 5);
});

Deno.test("a run older than 30 minutes since its first request fails with the timeout code and makes no Flex call", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [flexFail(1019)]) });
  let run = await advanceRun(rig.deps, await newRun(rig));
  assertEquals(run.state, "requested");
  rig.clock.t += 31 * 60_000;
  const before = rig.flex.calls.length;
  run = await advanceRun(rig.deps, run);
  assertEquals(
    [run.state, run.error_code, run.rows_summary["timeout"], rig.flex.calls.length],
    ["failed", -4, true, before],
  );
});
