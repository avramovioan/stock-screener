import { assertEquals } from "@std/assert";
import { DEFAULT_RESEARCH_SETTINGS, parseResearchSettings } from "./research_types.ts";

Deno.test("parseResearchSettings: a null report cap stays null (unlimited)", () => {
  const s = parseResearchSettings({ max_full_reports_per_day: null, tavily_daily_cap: 10 });
  assertEquals(s.max_full_reports_per_day, null);
  assertEquals(s.tavily_daily_cap, 10);
});

Deno.test("parseResearchSettings: an absent report cap means unlimited, other keys keep their defaults", () => {
  const s = parseResearchSettings({ tavily_daily_cap: 10 });
  assertEquals(s.max_full_reports_per_day, null);
  assertEquals(s.llm_daily_request_cap, DEFAULT_RESEARCH_SETTINGS.llm_daily_request_cap);
});

Deno.test("parseResearchSettings: no row at all is unlimited with default free-quota guards", () => {
  const s = parseResearchSettings(null);
  assertEquals(s.max_full_reports_per_day, null);
  assertEquals(s.tavily_monthly_budget, 950);
});

Deno.test("parseResearchSettings: a numeric report cap is kept", () => {
  assertEquals(parseResearchSettings({ max_full_reports_per_day: 3 }).max_full_reports_per_day, 3);
});

Deno.test("parseResearchSettings: cadence defaults are 72 hours and weekdays only", () => {
  const s = parseResearchSettings(null);
  assertEquals(s.min_recheck_hours, 72);
  assertEquals(s.ai_weekdays_only, true);
  assertEquals(DEFAULT_RESEARCH_SETTINGS.min_recheck_hours, 72);
  assertEquals(DEFAULT_RESEARCH_SETTINGS.ai_weekdays_only, true);
});

Deno.test("parseResearchSettings: min_recheck_hours is validated and bounded to 1..720", () => {
  const hours = (v: unknown) => parseResearchSettings({ min_recheck_hours: v }).min_recheck_hours;
  assertEquals(hours(48), 48);
  assertEquals(hours(0), 1);
  assertEquals(hours(-5), 1);
  assertEquals(hours(100000), 720);
  assertEquals(hours(36.6), 36);
  assertEquals(hours("72"), 72);
  assertEquals(hours("abc"), 72);
  assertEquals(hours(null), 72);
  assertEquals(hours(Number.NaN), 72);
});

Deno.test("parseResearchSettings: ai_weekdays_only accepts only a boolean", () => {
  const flag = (v: unknown) => parseResearchSettings({ ai_weekdays_only: v }).ai_weekdays_only;
  assertEquals(flag(false), false);
  assertEquals(flag(true), true);
  assertEquals(flag("false"), true);
  assertEquals(flag(0), true);
  assertEquals(flag(null), true);
});

Deno.test("parseResearchSettings: visitor limits default to 3 per hour per network, 8 per day, 60 minutes retry", () => {
  const s = parseResearchSettings({});
  assertEquals(
    [s.visitor_scans_per_hour_per_ip, s.visitor_scans_per_day, s.visitor_retry_minutes],
    [3, 8, 60],
  );
  assertEquals(parseResearchSettings({ visitor_scans_per_day: 12 }).visitor_scans_per_day, 12);
});
