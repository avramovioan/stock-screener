import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/** Small accessible popover: button + dialog panel; Escape and outside click close it, focus returns to the button. */
export function Popover({
  trigger,
  triggerLabel,
  panelLabel,
  panelClassName = "w-72",
  children,
}: {
  trigger: ReactNode;
  triggerLabel: string;
  panelLabel: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-block">
      <button
        ref={button}
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded px-1 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={id}
          role="dialog"
          aria-label={panelLabel}
          className={`absolute right-0 z-20 mt-1 max-h-96 max-w-[90vw] overflow-auto rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-md ${panelClassName}`}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}
