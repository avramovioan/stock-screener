import { useEffect, useState } from "react";

/** "just now" (under a minute), "{n} minutes ago", "{n} hours ago", "1 day ago", "{n} days ago". */
export function relativeTime(then: string | number | Date, now: Date): string {
  const t = then instanceof Date ? then.getTime() : new Date(then).getTime();
  if (Number.isNaN(t)) return "";
  const minutes = Math.floor((now.getTime() - t) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The current time, refreshed every minute while the page is open. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
