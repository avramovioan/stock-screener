import type { EuExchange } from "@core/eu-exchanges.ts";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { CountryFlag } from "@/components/country-flag";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { groupExchanges } from "./exchange-options";

interface ExchangeComboboxProps {
  id: string;
  label: string;
  exchanges: readonly EuExchange[];
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: string;
  disabled?: boolean;
}

/** ARIA 1.2 editable combobox with a listbox popup grouped by country. Selecting writes the MIC into the field. */
export function ExchangeCombobox({
  id,
  label,
  exchanges,
  value,
  onChange,
  error,
  hint,
  disabled,
}: ExchangeComboboxProps) {
  const uid = useId();
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // True once the user has typed since the last selection/focus; until then an exact MIC is a choice, not a filter
  const [edited, setEdited] = useState(false);

  const browseAll = !edited && exchanges.some((ex) => ex.mic === value);
  const query = browseAll ? "" : value;
  const groups = useMemo(() => groupExchanges(exchanges, query), [exchanges, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.exchanges), [groups]);
  const optionId = (mic: string) => `${uid}-opt-${mic}`;
  // Arrow keys: the explicitly navigated option, else the committed MIC while browsing the full list
  const current = active >= 0 ? active : browseAll ? flat.findIndex((ex) => ex.mic === value) : -1;
  const activeMic = current >= 0 ? flat[current]?.mic : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: optionId only depends on uid
  useEffect(() => {
    if (!open || !activeMic) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[id="${optionId(activeMic)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeMic]);

  function select(ex: EuExchange) {
    onChange(ex.mic);
    setEdited(false);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = flat.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) setOpen(true);
        setActive(last < 0 ? -1 : current >= last ? 0 : current + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) setOpen(true);
        setActive(last < 0 ? -1 : current <= 0 ? last : current - 1);
        break;
      case "Home":
        // Only once an option is active; before that Home/End move the text cursor as usual
        if (open && current >= 0) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open && current >= 0) {
          event.preventDefault();
          setActive(last);
        }
        break;
      case "Enter": {
        const ex = open ? flat[active] : undefined;
        if (ex) {
          event.preventDefault(); // select, do not submit the form
          select(ex);
        }
        break;
      }
      case "Escape":
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setActive(-1);
        }
        break;
      default:
    }
  }

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  const expanded = open && flat.length > 0;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={id}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && activeMic ? optionId(activeMic) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            setEdited(true);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => {
            setEdited(false);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          hidden={!expanded}
          onMouseDown={(event) => event.preventDefault()}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {groups.map((group) => {
            const headingId = `${uid}-group-${group.country}`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a fieldset is not valid inside a listbox
              <div key={group.country} role="group" aria-labelledby={headingId}>
                <div
                  id={headingId}
                  className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground"
                >
                  <CountryFlag code={group.country} />
                  {group.countryName}
                </div>
                {group.exchanges.map((ex) => {
                  const isActive = ex.mic === activeMic;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard use goes through the input (aria-activedescendant)
                    <div
                      key={ex.mic}
                      id={optionId(ex.mic)}
                      role="option"
                      aria-selected={isActive}
                      tabIndex={-1}
                      className={`flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1.5 text-sm ${isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
                      onClick={() => select(ex)}
                    >
                      <span className="font-semibold">{ex.mic}</span>
                      <span className="text-xs text-muted-foreground">{ex.name}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
