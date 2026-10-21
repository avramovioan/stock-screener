import { mergeSettings } from "../_shared/adapters/settings.ts";
import { assertSignalGradeSettings, validateSettings } from "../_shared/core/indicator.ts";

/** Request validation of scan-control (pure). Every action is explicit; unknown actions and malformed arguments are rejected. */

export const ACTIONS = [
  "start",
  "status",
  "requeue",
  "recompute",
  "list_failures",
  "set_setting",
  "override",
  "research_now",
  "telegram_test",
  "telegram_send_latest",
] as const;
export type Action = (typeof ACTIONS)[number];

export const SETTING_KEYS = ["indicator", "universe", "pipeline", "providers"] as const;
export const OVERRIDE_KINDS = [
  "force_canonical",
  "exclude",
  "force_us",
  "force_not_us",
  "merge_into_company",
  "predecessor_continuity",
] as const;

export type Parsed =
  | {
      ok: true;
      action: "start";
      now: string | null;
      providerMode: "live" | "fixture";
      fixtureSet: string | null;
    }
  | { ok: true; action: "status" | "requeue" | "recompute" | "list_failures"; run: string | null }
  | {
      ok: true;
      action: "set_setting";
      key: (typeof SETTING_KEYS)[number];
      value: unknown;
      reason: string;
    }
  | {
      ok: true;
      action: "override";
      kind: (typeof OVERRIDE_KINDS)[number];
      yahooSymbol: string;
      reason: string;
      targetCompanyId: string | null;
      payload: Record<string, unknown>;
    }
  | { ok: true; action: "research_now"; securityId: string; force: boolean }
  | { ok: true; action: "telegram_test" }
  | { ok: true; action: "telegram_send_latest" }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (error: string): Parsed => ({ ok: false, error });

export function parseRequest(body: unknown): Parsed {
  if (!isRec(body) || typeof body["action"] !== "string") return fail("action_required");
  const action = body["action"] as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return fail("unknown_action");

  const run = body["run"] === undefined || body["run"] === null ? null : String(body["run"]);
  if (run !== null && !UUID.test(run) && !/^\d{4}-\d{2}-\d{2}$/.test(run))
    return fail("run_must_be_a_uuid_or_a_date");

  switch (action as Action) {
    case "start": {
      const mode =
        body["provider_mode"] === "fixture"
          ? "fixture"
          : body["provider_mode"] === undefined || body["provider_mode"] === "live"
            ? "live"
            : null;
      if (mode === null) return fail("provider_mode_must_be_live_or_fixture");
      const now = body["now"] === undefined || body["now"] === null ? null : String(body["now"]);
      if (now !== null && !Number.isFinite(Date.parse(now)))
        return fail("now_must_be_an_iso_timestamp");
      if (now !== null && mode !== "fixture") return fail("now_is_only_allowed_in_fixture_mode");
      const set =
        body["fixture_set"] === undefined || body["fixture_set"] === null
          ? null
          : String(body["fixture_set"]);
      if (set !== null && !/^[a-z0-9_-]{1,32}$/.test(set)) return fail("fixture_set_invalid");
      return { ok: true, action: "start", now, providerMode: mode, fixtureSet: set };
    }
    case "status":
    case "requeue":
    case "recompute":
    case "list_failures":
      if ((action === "requeue" || action === "recompute") && run === null)
        return fail("run_required");
      return {
        ok: true,
        action: action as "status" | "requeue" | "recompute" | "list_failures",
        run,
      };
    case "set_setting": {
      const key = body["key"];
      if (!(SETTING_KEYS as readonly unknown[]).includes(key))
        return fail("key_must_be_indicator_universe_or_pipeline");
      if (body["confirm"] !== true)
        return fail("confirm_true_required: settings never change silently");
      const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
      if (reason.length < 3) return fail("reason_required");
      const value = body["value"];
      if (key === "indicator") {
        const checked = validateSettings(value);
        if (!checked.ok)
          return fail(
            `invalid_indicator: ${checked.issues.map((i) => `${i.field}:${i.code}`).join(",")}`,
          );
        try {
          assertSignalGradeSettings(checked.settings);
        } catch {
          return fail(
            "settings_not_signal_grade: only length may differ from 3/4/1/2 with all modes true",
          );
        }
        return { ok: true, action: "set_setting", key, value: checked.settings, reason };
      }
      if (key === "providers") {
        if (
          !isRec(value) ||
          typeof value["yahoo_enabled"] !== "boolean" ||
          Object.keys(value).some((k) => k !== "yahoo_enabled")
        )
          return fail("providers_must_be_exactly_yahoo_enabled_boolean");
        return { ok: true, action: "set_setting", key, value, reason };
      }
      if (!isRec(value)) return fail("value_must_be_an_object");
      const probe = mergeSettings([{ key: key as string, value }]);
      if (probe.warnings.length > 0) return fail(`invalid_value: ${probe.warnings.join("; ")}`);
      return {
        ok: true,
        action: "set_setting",
        key: key as "universe" | "pipeline",
        value,
        reason,
      };
    }
    case "telegram_send_latest":
      return { ok: true, action: "telegram_send_latest" };
    case "telegram_test":
      return { ok: true, action: "telegram_test" };
    case "research_now": {
      const securityId = body["security_id"];
      if (typeof securityId !== "string" || !UUID.test(securityId))
        return fail("security_id_required");
      return {
        ok: true,
        action: "research_now",
        securityId,
        force: body["force"] === true,
      };
    }
    case "override": {
      const kind = body["kind"];
      if (!(OVERRIDE_KINDS as readonly unknown[]).includes(kind)) return fail("kind_invalid");
      const symbol = typeof body["yahoo_symbol"] === "string" ? body["yahoo_symbol"].trim() : "";
      if (symbol.length === 0 || symbol.length > 24) return fail("yahoo_symbol_required");
      const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
      if (reason.length < 3) return fail("reason_required");
      const target =
        body["target_company_id"] === undefined || body["target_company_id"] === null
          ? null
          : String(body["target_company_id"]);
      if (kind === "merge_into_company" && (target === null || !UUID.test(target)))
        return fail("target_company_id_required");
      return {
        ok: true,
        action: "override",
        kind: kind as (typeof OVERRIDE_KINDS)[number],
        yahooSymbol: symbol,
        reason,
        targetCompanyId: target,
        payload: isRec(body["payload"]) ? body["payload"] : {},
      };
    }
  }
}
