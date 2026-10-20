import { useId } from "react";
import { CountryFlag } from "@/components/country-flag";
import { type CountryFilter, US_COUNTRY } from "@/features/screening/country-filter";

const OPTIONS: { value: CountryFilter; label: string; flag: boolean }[] = [
  { value: "all", label: "All exchanges", flag: false },
  { value: "us", label: US_COUNTRY, flag: true },
];

/**
 * "Listed in": a two-option radio group (All exchanges / United States) drawn as a segmented control.
 * Native radio inputs give the arrow-key and focus behaviour; the optional help line stays available to
 * assistive technology on a phone, where the Overview does not draw it.
 */
export function CountryFilterControl({
  value,
  onChange,
  disabled = false,
  helpText,
  helpOnPhone = false,
}: {
  value: CountryFilter;
  onChange: (next: CountryFilter) => void;
  disabled?: boolean;
  helpText?: string;
  /** Draw the help line on a phone too (the Overview leaves it to assistive technology there). */
  helpOnPhone?: boolean;
}) {
  const labelId = useId();
  const helpId = useId();
  const name = useId();
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
      <span id={labelId} className="text-sm text-muted-foreground">
        Listed in
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={helpText ? helpId : undefined}
        className="grid grid-cols-2 gap-0.5 rounded-[10px] border bg-card p-[3px] sm:inline-flex"
      >
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-[7px] px-3 text-sm font-medium has-[:checked]:bg-foreground has-[:checked]:text-background has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/60 sm:min-h-[38px] sm:px-3.5 [&:not(:has(:checked))]:hover:bg-muted"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.flag ? <CountryFlag country={US_COUNTRY} /> : null}
            {option.label}
          </label>
        ))}
      </div>
      {helpText ? (
        <span
          id={helpId}
          className={`text-[13px] text-muted-foreground ${helpOnPhone ? "" : "sr-only sm:not-sr-only"}`}
        >
          {helpText}
        </span>
      ) : null}
    </div>
  );
}
