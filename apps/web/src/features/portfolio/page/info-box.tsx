import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** An ⓘ button that opens one small box (Radix popover: one at a time, Escape and outside click close it, focus returns to the button). */
export function InfoBox({
  label,
  title,
  active = false,
  className = "w-80",
  children,
}: {
  /** Accessible name of the button, also the box's name unless `title` is given. */
  label: string;
  title?: string;
  /** Row boxes are tinted when they carry something worth a look. */
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={`inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:size-11 ${active ? "bg-muted text-foreground" : ""}`}
        >
          <Info aria-hidden="true" size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label={title ?? label}
        align="end"
        className={`${className} space-y-2 text-[13px]`}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** Label and value pairs inside a row box. */
export function FactList({ facts }: { facts: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1">
      {facts.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="m-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
