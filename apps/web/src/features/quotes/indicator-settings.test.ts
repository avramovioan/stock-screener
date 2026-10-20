import { DEFAULT_SETTINGS } from "@core/indicator.ts";
import { describe, expect, it } from "vitest";
import { LINE_KEYS } from "./chart-data";
import { DEFAULT_VISIBILITY, draftFromSettings, parseDraft } from "./indicator-settings";

describe("indicator settings draft", () => {
  it("round-trips the defaults", () => {
    const parsed = parseDraft(draftFromSettings(DEFAULT_SETTINGS));
    expect(parsed).toEqual({ ok: true, settings: DEFAULT_SETTINGS, warnings: [] });
  });
  it("defaults make every line visible", () => {
    for (const k of LINE_KEYS) expect(DEFAULT_VISIBILITY[k]).toBe(true);
  });
  it("accepts length 3..5000 and rejects outside", () => {
    const d = draftFromSettings(DEFAULT_SETTINGS);
    expect(parseDraft({ ...d, length: "3" }).ok).toBe(true);
    expect(parseDraft({ ...d, length: "5000" }).ok).toBe(true);
    expect(parseDraft({ ...d, length: "2" }).ok).toBe(false);
    expect(parseDraft({ ...d, length: "5001" }).ok).toBe(false);
    expect(parseDraft({ ...d, length: "abc" }).ok).toBe(false);
    expect(parseDraft({ ...d, length: "10.5" }).ok).toBe(false);
  });
  it("rejects zero, negative and non-numeric multipliers", () => {
    const d = draftFromSettings(DEFAULT_SETTINGS);
    expect(parseDraft({ ...d, upper1Mult: "0" }).ok).toBe(false);
    expect(parseDraft({ ...d, lower2Mag: "-4" }).ok).toBe(false);
    expect(parseDraft({ ...d, upper2Mult: "" }).ok).toBe(false);
  });
  it("short windows are accepted with a warning", () => {
    const r = parseDraft({ ...draftFromSettings(DEFAULT_SETTINGS), length: "20" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("mode flags pass through unchanged", () => {
    const r = parseDraft({ ...draftFromSettings(DEFAULT_SETTINGS), upper1Mode: false });
    expect(r.ok && r.settings.upper1Mode).toBe(false);
  });
});
