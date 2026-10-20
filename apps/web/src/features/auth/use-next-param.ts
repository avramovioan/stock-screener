import { useSearch } from "@tanstack/react-router";

/** The raw `next` search parameter, if it is a string. Always pass it through safeNext before use. */
export function useNextParam(): string | undefined {
  const search = useSearch({ strict: false }) as { next?: unknown };
  return typeof search.next === "string" ? search.next : undefined;
}
