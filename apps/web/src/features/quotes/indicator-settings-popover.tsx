import type { IndicatorSettings } from "@core/indicator.ts";
import { useEffect, useState } from "react";
import { Popover } from "@/components/popover";
import { LINE_KEYS, LINE_TITLES, type LineKey } from "./chart-data";
import {
  draftFromSettings,
  parseDraft,
  type SettingsDraft,
  type Visibility,
} from "./indicator-settings";

const MODE_LABEL = "Use σ multiplier / Use max high-low deviation";

const ROWS: {
  title: string;
  value: keyof SettingsDraft;
  mode: keyof SettingsDraft;
  valueLabel: string;
}[] = [
  { title: "+1 line", value: "upper1Mult", mode: "upper1Mode", valueLabel: "+1 multiplier" },
  { title: "+2 line", value: "upper2Mult", mode: "upper2Mode", valueLabel: "+2 multiplier" },
  { title: "-3 line", value: "lower1Mag", mode: "lower1Mode", valueLabel: "-3 magnitude" },
  { title: "-4 line", value: "lower2Mag", mode: "lower2Mode", valueLabel: "-4 magnitude" },
];

const FIELD = "min-h-9 w-24 rounded border bg-background px-2 py-1 tabular-nums";
const CHECK_ROW = "flex min-h-9 items-center gap-2";

/** Client-side only: nothing here is stored or sent; the screening scan always uses the defaults. */
export function IndicatorSettingsPopover(props: {
  settings: IndicatorSettings;
  visibility: Visibility;
  onApply: (s: IndicatorSettings) => void;
  onVisibilityChange: (key: LineKey, visible: boolean) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(props.settings));
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => setDraft(draftFromSettings(props.settings)), [props.settings]);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const r = parseDraft(draft);
    if (!r.ok) {
      setErrors(r.messages);
      setWarnings([]);
      return;
    }
    setErrors([]);
    setWarnings(r.warnings);
    props.onApply(r.settings);
  };

  return (
    <Popover
      trigger="Indicator settings"
      triggerLabel="Indicator settings"
      panelLabel="Indicator settings"
      panelClassName="w-96"
    >
      <form onSubmit={apply} noValidate className="space-y-3">
        <label className="flex items-center justify-between gap-2">
          <span>Length (bars, 3 to 5000)</span>
          <input
            type="number"
            min={3}
            max={5000}
            step={1}
            value={draft.length}
            onChange={(e) => setDraft({ ...draft, length: e.target.value })}
            className={FIELD}
          />
        </label>
        {ROWS.map((r) => (
          <fieldset key={r.title} className="space-y-1 rounded border p-2">
            <legend className="px-1 font-medium">{r.title}</legend>
            <label className="flex items-center justify-between gap-2">
              <span>{r.valueLabel}</span>
              <input
                type="number"
                step="any"
                min={0}
                value={String(draft[r.value])}
                onChange={(e) => setDraft({ ...draft, [r.value]: e.target.value })}
                className={FIELD}
              />
            </label>
            <label className={CHECK_ROW}>
              <input
                type="checkbox"
                checked={Boolean(draft[r.mode])}
                onChange={(e) => setDraft({ ...draft, [r.mode]: e.target.checked })}
                className="size-4"
              />
              <span>
                <span className="sr-only">{`${r.title}: `}</span>
                {MODE_LABEL}
              </span>
            </label>
          </fieldset>
        ))}
        <p className="text-xs text-muted-foreground">
          Unchecking switches the mode; it does not hide the line. The line is still drawn, using
          the maximum historical high-low deviation instead of the σ multiplier.
        </p>
        <fieldset className="space-y-1 rounded border p-2">
          <legend className="px-1 font-medium">Show or hide lines</legend>
          {LINE_KEYS.map((k) => (
            <label key={k} className={CHECK_ROW}>
              <input
                type="checkbox"
                checked={props.visibility[k]}
                onChange={(e) => props.onVisibilityChange(k, e.target.checked)}
                className="size-4"
              />
              <span>{`Show ${LINE_TITLES[k]} line`}</span>
            </label>
          ))}
        </fieldset>
        {errors.length > 0 ? (
          <div role="alert" className="text-sm font-medium text-[var(--status-red-fg)]">
            {errors.join(" ")}
          </div>
        ) : null}
        {warnings.length > 0 ? <p className="text-sm">{warnings.join(" ")}</p> : null}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={props.onReset}
            className="min-h-9 rounded px-1 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Reset to defaults
          </button>
          <button
            type="submit"
            className="min-h-9 rounded border bg-primary px-4 py-1 font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Apply
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          These settings only change this chart in your browser. The daily screening scan always
          uses the defaults (length 2,500; +1, +2, -3, -4).
        </p>
      </form>
    </Popover>
  );
}
