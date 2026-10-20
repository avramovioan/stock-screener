import { useState } from "react";
import { ErrorState } from "@/components/data-state/data-state";
import { errorText } from "@/features/screening/errors";
import type { SearchHit } from "@/features/screening/quotes-api";
import { useSymbolSearch } from "@/features/screening/quotes-hooks";
import type { DiscountRow } from "@/features/screening/types";
import { optionLabel, type Selection, selectionFromDiscount, selectionFromHit } from "./selection";
import { useDebouncedValue } from "./use-debounced-value";

const CONTROL =
  "min-h-11 w-full max-w-xl rounded-md border bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Native select (keyboard and screen-reader friendly): today's discount securities, canonical listing. */
export function StockSelect({
  options,
  symbol,
  onSelect,
}: {
  options: readonly DiscountRow[];
  symbol: string | undefined;
  onSelect: (s: Selection) => void;
}) {
  const inList = symbol !== undefined && options.some((o) => o.yahoo_symbol === symbol);
  return (
    <div className="space-y-1">
      <label htmlFor="stock-select" className="block text-sm font-medium">
        Select a stock from today
      </label>
      <select
        id="stock-select"
        value={inList ? symbol : ""}
        onChange={(e) => {
          const row = options.find((o) => o.yahoo_symbol === e.target.value);
          if (row) onSelect(selectionFromDiscount(row));
        }}
        className={CONTROL}
      >
        {!inList ? (
          <option value="" disabled>
            {symbol ? `Searched security: ${symbol}` : "Choose from today's list"}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.security_id} value={o.yahoo_symbol}>
            {optionLabel(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Debounced (300 ms, min 2 characters) search. Results are a list; only clicking one changes the selection. */
export function SymbolSearch({
  onPick,
  debounceMs = 300,
}: {
  onPick: (s: Selection) => void;
  debounceMs?: number;
}) {
  const [text, setText] = useState("");
  const debounced = useDebouncedValue(text, debounceMs);
  const search = useSymbolSearch(debounced);
  const active = debounced.trim().length >= 2 && text.trim().length >= 2;
  const pick = (hit: SearchHit) => {
    onPick(selectionFromHit(hit));
    setText("");
  };
  return (
    <div className="space-y-1">
      <label htmlFor="symbol-search" className="block text-sm font-medium">
        Search for a security
      </label>
      <input
        id="symbol-search"
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
        placeholder="Name or ticker, at least 2 characters"
        className={CONTROL}
      />
      <div aria-live="polite">
        {active && search.isLoading ? (
          <p className="text-sm text-muted-foreground">Searching...</p>
        ) : null}
        {active && search.isError ? (
          <ErrorState message={errorText(search.error)} onRetry={() => void search.refetch()} />
        ) : null}
        {active && search.data && search.data.length === 0 ? (
          <p className="text-sm">No matches</p>
        ) : null}
        {active && search.data && search.data.length > 0 ? (
          <ul aria-label="Search results" className="max-w-xl divide-y rounded-md border">
            {search.data.map((hit) => (
              <li key={`${hit.symbol}-${hit.exchange}`}>
                <button
                  type="button"
                  onClick={() => pick(hit)}
                  className="min-h-11 w-full px-3 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  {`${hit.symbol} — ${hit.longName ?? hit.shortName ?? "Unknown"} (${hit.exchange})`}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
