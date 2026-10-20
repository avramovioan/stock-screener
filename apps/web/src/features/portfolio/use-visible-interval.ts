import { useEffect, useRef } from "react";

/**
 * Calls `callback` every `ms` while the document is visible and `enabled`. Hidden: the timer is cleared (no background polling).
 * On becoming visible it runs once immediately when the last run (`lastRunAt`) is older than `ms`, then resumes the interval.
 * The app does not rely on TanStack Query's background-refetch options (spec 14.2).
 */
export function useVisibleInterval(
  callback: () => void,
  ms: number,
  opts: { enabled?: boolean; lastRunAt?: () => number | null } = {},
): void {
  const cb = useRef(callback);
  const lastRunAt = useRef(opts.lastRunAt);
  cb.current = callback;
  lastRunAt.current = opts.lastRunAt;
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setInterval(() => cb.current(), ms);
    };
    const onChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      const last = lastRunAt.current?.() ?? null;
      if (last !== null && Date.now() - last >= ms) cb.current();
      start();
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      stop();
    };
  }, [enabled, ms]);
}
