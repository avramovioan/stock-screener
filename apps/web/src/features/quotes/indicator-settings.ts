import { type IndicatorSettings, validateSettings } from "@core/indicator.ts";
import type { LineKey } from "./chart-data";

export type Visibility = Record<LineKey, boolean>;
export const DEFAULT_VISIBILITY: Visibility = {
  upper2: true,
  upper1: true,
  base: true,
  lower1: true,
  lower2: true,
};

export interface SettingsDraft {
  length: string;
  upper1Mult: string;
  upper2Mult: string;
  lower1Mag: string;
  lower2Mag: string;
  upper1Mode: boolean;
  upper2Mode: boolean;
  lower1Mode: boolean;
  lower2Mode: boolean;
}

export function draftFromSettings(s: IndicatorSettings): SettingsDraft {
  return {
    length: String(s.length),
    upper1Mult: String(s.upper1Mult),
    upper2Mult: String(s.upper2Mult),
    lower1Mag: String(s.lower1Mag),
    lower2Mag: String(s.lower2Mag),
    upper1Mode: s.upper1Mode,
    upper2Mode: s.upper2Mode,
    lower1Mode: s.lower1Mode,
    lower2Mode: s.lower2Mode,
  };
}

const num = (s: string): number => (s.trim() === "" ? Number.NaN : Number(s));

/** Parses the text fields and validates with the same rules the backend uses (core validateSettings). */
export function parseDraft(
  d: SettingsDraft,
):
  | { ok: true; settings: IndicatorSettings; warnings: string[] }
  | { ok: false; messages: string[] } {
  const candidate = {
    length: num(d.length),
    upper1Mode: d.upper1Mode,
    upper1Mult: num(d.upper1Mult),
    upper2Mode: d.upper2Mode,
    upper2Mult: num(d.upper2Mult),
    lower1Mode: d.lower1Mode,
    lower1Mag: num(d.lower1Mag),
    lower2Mode: d.lower2Mode,
    lower2Mag: num(d.lower2Mag),
  };
  const r = validateSettings(candidate);
  if (!r.ok) return { ok: false, messages: r.issues.map((i) => i.message) };
  return { ok: true, settings: r.settings, warnings: r.warnings.map((w) => w.message) };
}
