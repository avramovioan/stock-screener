import type { ReactNode } from "react";
import { Skeleton as UiSkeleton } from "@/components/ui/skeleton";

/** shadcn skeleton, hidden from assistive technology; no pulse under prefers-reduced-motion. */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return (
    <UiSkeleton aria-hidden="true" className={`skeleton motion-reduce:animate-none ${className}`} />
  );
}

/** Skeleton of the final layout; `rows` stacked bars. */
export function Loading({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="space-y-2">
      <span className="sr-only">{`${label}...`}</span>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder bars
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

/** Never a blank: the message plus an optional Retry. */
export function ErrorState({
  title = "Could not load this section",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div role="alert" className="rounded-md border border-[var(--status-red-bd)] p-4">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border px-3 py-1 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed p-6 text-center">
      <p className="font-medium">{title}</p>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {children}
    </div>
  );
}
