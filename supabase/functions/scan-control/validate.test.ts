import { assertEquals } from "@std/assert";
import { DEFAULT_SETTINGS } from "../_shared/core/indicator.ts";
import { parseRequest } from "./validate.ts";

const err = (body: unknown) => {
  const p = parseRequest(body);
  return p.ok ? null : p.error;
};
const RUN = "11111111-2222-3333-4444-555555555555";

Deno.test("rejects missing and unknown actions", () => {
  assertEquals(err(null), "action_required");
  assertEquals(err({}), "action_required");
  assertEquals(err({ action: "drop_database" }), "unknown_action");
});

Deno.test("start: live by default, fixture needs no real clock, now only in fixture mode", () => {
  assertEquals(parseRequest({ action: "start" }), {
    ok: true,
    action: "start",
    now: null,
    providerMode: "live",
    fixtureSet: null,
  });
  assertEquals(
    parseRequest({
      action: "start",
      provider_mode: "fixture",
      fixture_set: "day2",
      now: "2026-10-16T07:00:00Z",
    }),
    {
      ok: true,
      action: "start",
      now: "2026-10-16T07:00:00Z",
      providerMode: "fixture",
      fixtureSet: "day2",
    },
  );
  assertEquals(
    err({ action: "start", now: "2026-10-16T07:00:00Z" }),
    "now_is_only_allowed_in_fixture_mode",
  );
  assertEquals(
    err({ action: "start", provider_mode: "mock" }),
    "provider_mode_must_be_live_or_fixture",
  );
  assertEquals(
    err({ action: "start", provider_mode: "fixture", now: "yesterday" }),
    "now_must_be_an_iso_timestamp",
  );
  assertEquals(
    err({ action: "start", provider_mode: "fixture", fixture_set: "../etc" }),
    "fixture_set_invalid",
  );
});

Deno.test("status, requeue, recompute and list_failures take a run id or a date; requeue and recompute require it", () => {
  assertEquals(parseRequest({ action: "status" }), { ok: true, action: "status", run: null });
  assertEquals(parseRequest({ action: "list_failures", run: "2026-10-15" }), {
    ok: true,
    action: "list_failures",
    run: "2026-10-15",
  });
  assertEquals(parseRequest({ action: "requeue", run: RUN }), {
    ok: true,
    action: "requeue",
    run: RUN,
  });
  assertEquals(err({ action: "requeue" }), "run_required");
  assertEquals(err({ action: "recompute" }), "run_required");
  assertEquals(
    err({ action: "status", run: "latest; drop table scan_runs" }),
    "run_must_be_a_uuid_or_a_date",
  );
});

Deno.test("set_setting: explicit confirmation, a reason and a valid, signal-grade value are mandatory", () => {
  const ok = {
    action: "set_setting",
    key: "indicator",
    value: { ...DEFAULT_SETTINGS, length: 2000 },
    confirm: true,
    reason: "shorter window for a test",
  };
  assertEquals(parseRequest(ok).ok, true);
  assertEquals(
    err({ ...ok, confirm: undefined }),
    "confirm_true_required: settings never change silently",
  );
  assertEquals(
    err({ ...ok, confirm: "yes" }),
    "confirm_true_required: settings never change silently",
  );
  assertEquals(err({ ...ok, reason: "" }), "reason_required");
  assertEquals(err({ ...ok, key: "secrets" }), "key_must_be_indicator_universe_or_pipeline");
  assertEquals(
    err({ ...ok, value: { ...DEFAULT_SETTINGS, length: 2 } }),
    "invalid_indicator: length:length_out_of_range",
  );
  assertEquals(
    err({ ...ok, value: { ...DEFAULT_SETTINGS, lower1Mag: 2 } })?.startsWith(
      "settings_not_signal_grade",
    ),
    true,
  );
  assertEquals(
    err({ ...ok, value: { ...DEFAULT_SETTINGS, lower1Mode: "true" } })?.startsWith(
      "invalid_indicator",
    ),
    true,
  );
});

Deno.test("set_setting for universe and pipeline validates the values through the settings merge", () => {
  assertEquals(
    parseRequest({
      action: "set_setting",
      key: "universe",
      value: { threshold_usd: 60e9 },
      confirm: true,
      reason: "raise the floor",
    }).ok,
    true,
  );
  assertEquals(
    err({
      action: "set_setting",
      key: "universe",
      value: { threshold_usd: "lots" },
      confirm: true,
      reason: "raise the floor",
    })?.startsWith("invalid_value"),
    true,
  );
  assertEquals(
    err({
      action: "set_setting",
      key: "pipeline",
      value: { yahoo: { min_spacing_ms: 50 } },
      confirm: true,
      reason: "go faster",
    })?.startsWith("invalid_value"),
    true,
  );
  assertEquals(
    err({ action: "set_setting", key: "pipeline", value: [1], confirm: true, reason: "nope nope" }),
    "value_must_be_an_object",
  );
});

Deno.test("override: kind, symbol and reason are required; merge_into_company needs a target company", () => {
  assertEquals(
    parseRequest({
      action: "override",
      kind: "exclude",
      yahoo_symbol: "MSFT.AS",
      reason: "leveraged tracker ETP",
    }),
    {
      ok: true,
      action: "override",
      kind: "exclude",
      yahooSymbol: "MSFT.AS",
      reason: "leveraged tracker ETP",
      targetCompanyId: null,
      payload: {},
    },
  );
  assertEquals(
    err({ action: "override", kind: "burn", yahoo_symbol: "X", reason: "because" }),
    "kind_invalid",
  );
  assertEquals(
    err({ action: "override", kind: "exclude", yahoo_symbol: "", reason: "because" }),
    "yahoo_symbol_required",
  );
  assertEquals(
    err({ action: "override", kind: "exclude", yahoo_symbol: "X", reason: "" }),
    "reason_required",
  );
  assertEquals(
    err({
      action: "override",
      kind: "merge_into_company",
      yahoo_symbol: "X",
      reason: "same company",
    }),
    "target_company_id_required",
  );
  assertEquals(
    parseRequest({
      action: "override",
      kind: "merge_into_company",
      yahoo_symbol: "X",
      reason: "same company",
      target_company_id: RUN,
    }).ok,
    true,
  );
});

Deno.test("research_now: needs a security id, force only when literally true", () => {
  assertEquals(err({ action: "research_now" }), "security_id_required");
  assertEquals(err({ action: "research_now", security_id: "not valid!" }), "security_id_required");
  assertEquals(err({ action: "research_now", security_id: 7 }), "security_id_required");
  assertEquals(err({ action: "research_now", security_id: "sec-1" }), "security_id_required");
  assertEquals(parseRequest({ action: "research_now", security_id: RUN }), {
    ok: true,
    action: "research_now",
    securityId: RUN,
    force: false,
  });
  assertEquals(parseRequest({ action: "research_now", security_id: RUN, force: "yes" }), {
    ok: true,
    action: "research_now",
    securityId: RUN,
    force: false,
  });
  assertEquals(parseRequest({ action: "research_now", security_id: RUN, force: true }), {
    ok: true,
    action: "research_now",
    securityId: RUN,
    force: true,
  });
});

Deno.test("set_setting providers accepts exactly { yahoo_enabled: boolean }", () => {
  const ok = parseRequest({
    action: "set_setting",
    key: "providers",
    value: { yahoo_enabled: false },
    confirm: true,
    reason: "yahoo block",
  });
  assertEquals(ok.ok, true);
  for (const value of [{ yahoo_enabled: "no" }, {}, { yahoo_enabled: true, other: 1 }]) {
    assertEquals(
      parseRequest({
        action: "set_setting",
        key: "providers",
        value,
        confirm: true,
        reason: "x yz",
      }).ok,
      false,
    );
  }
});

Deno.test("set_setting pipeline rejects unbounded timing values and an out-of-range heavy-job cap", () => {
  for (const value of [
    { hard_deadline_ms: 200_000 },
    { stop_claiming_ms: 100_001 },
    { lease_seconds: 60 },
    { max_heavy_jobs_per_invocation: 0 },
  ])
    assertEquals(
      err({
        action: "set_setting",
        key: "pipeline",
        value,
        confirm: true,
        reason: "tune the worker",
      })?.startsWith("invalid_value"),
      true,
      JSON.stringify(value),
    );
  assertEquals(
    parseRequest({
      action: "set_setting",
      key: "pipeline",
      value: { max_heavy_jobs_per_invocation: 3 },
      confirm: true,
      reason: "tune the worker",
    }).ok,
    true,
  );
});

Deno.test("telegram_test: needs no arguments", () => {
  assertEquals(parseRequest({ action: "telegram_test" }), { ok: true, action: "telegram_test" });
});
