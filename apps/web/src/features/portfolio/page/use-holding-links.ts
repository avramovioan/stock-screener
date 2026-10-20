import { useQuery } from "@tanstack/react-query";
import { holdingsApi } from "./holdings-default";

/** Secondary data (research state, trade targets): a failure just hides the extras, it never blocks the table. */
export function useHoldingLinks() {
  return useQuery({
    queryKey: ["holdingLinks"],
    queryFn: () => holdingsApi.links(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
