import { type ReactNode, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  hasFilters,
  NO_FILTERS,
  type TradeFilters,
  type TradeSide,
  type TradeType,
} from "./trades-api";

const TYPE_OPTIONS: ReadonlyArray<{ value: TradeType; text: string }> = [
  { value: "all", text: "All" },
  { value: "stocks", text: "Stocks and ETFs" },
  { value: "fx", text: "Currency (FX)" },
  { value: "bonds", text: "Bonds" },
];
const SIDE_OPTIONS: ReadonlyArray<{ value: TradeSide; text: string }> = [
  { value: "all", text: "All" },
  { value: "BUY", text: "Buy" },
  { value: "SELL", text: "Sell" },
];
const FIELD = "min-h-11 rounded-[10px] border bg-background px-2.5 text-sm";
const LABEL = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";
const TEXT_DEBOUNCE_MS = 300;

function Field({
  id,
  label,
  grow,
  children,
}: {
  id: string;
  label: string;
  grow: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${grow}`}>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** The trade history filter bar (spec 5.8). Free text is committed after a short pause; every other control at once. */
export function TradeFilterBar({
  filters,
  currencies,
  onChange,
}: {
  filters: TradeFilters;
  currencies: readonly string[];
  onChange(next: TradeFilters): void;
}) {
  const [text, setText] = useState(filters.q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // the debounced commit must see the filters of the moment it fires, not of the keystroke
  const latest = useRef({ filters, onChange });
  latest.current = { filters, onChange };
  useEffect(() => setText(filters.q), [filters.q]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const set = (patch: Partial<TradeFilters>) => onChange({ ...filters, ...patch });
  const ccys =
    filters.ccy !== "" && !currencies.includes(filters.ccy)
      ? [...currencies, filters.ccy]
      : currencies;

  return (
    <form
      aria-label="Trade history filters"
      className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-[14px] border bg-card px-5 py-4"
      onSubmit={(e) => e.preventDefault()}
    >
      <Field id="f-symbol" label="Symbol or name" grow="flex-[2_1_220px]">
        <Input
          id="f-symbol"
          type="search"
          className="min-h-11 rounded-[10px]"
          placeholder="MSFT, Microsoft, EUR.USD…"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            const value = e.target.value;
            setText(value);
            clearTimeout(timer.current);
            timer.current = setTimeout(
              () => latest.current.onChange({ ...latest.current.filters, q: value.trim() }),
              TEXT_DEBOUNCE_MS,
            );
          }}
        />
      </Field>
      <Field id="f-type" label="Type" grow="flex-[1_1_140px]">
        <select
          id="f-type"
          className={FIELD}
          value={filters.type}
          onChange={(e) => set({ type: e.target.value as TradeType })}
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text}
            </option>
          ))}
        </select>
      </Field>
      <Field id="f-side" label="Side" grow="flex-[1_1_120px]">
        <select
          id="f-side"
          className={FIELD}
          value={filters.side}
          onChange={(e) => set({ side: e.target.value as TradeSide })}
        >
          {SIDE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text}
            </option>
          ))}
        </select>
      </Field>
      <Field id="f-ccy" label="Currency" grow="flex-[1_1_120px]">
        <select
          id="f-ccy"
          className={FIELD}
          value={filters.ccy}
          onChange={(e) => set({ ccy: e.target.value })}
        >
          <option value="">All</option>
          {ccys.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field id="f-from" label="From" grow="flex-[1_1_150px]">
        <input
          id="f-from"
          type="date"
          className={FIELD}
          value={filters.from}
          max={filters.to === "" ? undefined : filters.to}
          onChange={(e) => set({ from: e.target.value })}
        />
      </Field>
      <Field id="f-to" label="To" grow="flex-[1_1_150px]">
        <input
          id="f-to"
          type="date"
          className={FIELD}
          value={filters.to}
          min={filters.from === "" ? undefined : filters.from}
          onChange={(e) => set({ to: e.target.value })}
        />
      </Field>
      <button
        type="button"
        className="min-h-11 rounded-[10px] px-3.5 text-sm font-medium text-primary underline disabled:no-underline disabled:opacity-50"
        disabled={!hasFilters(filters) && text === ""}
        onClick={() => {
          clearTimeout(timer.current);
          setText("");
          onChange(NO_FILTERS);
        }}
      >
        Clear filters
      </button>
    </form>
  );
}
