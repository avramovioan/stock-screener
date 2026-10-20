import type { Destination } from "@core/handoff.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/features/auth/auth-provider";
import { handoffApi } from "./default";

export const eurListingsKey = (securityId: string) => ["eur-listings", securityId] as const;
export const defaultDestinationKey = (userId: string | null) =>
  ["default-destination", userId] as const;

/** EUR lines of one canonical security (public data, cached 5 minutes). */
export function useEurListings(securityId: string | null) {
  return useQuery({
    queryKey: eurListingsKey(securityId ?? "none"),
    queryFn: () => handoffApi.getEurListings(securityId as string),
    enabled: securityId !== null,
    staleTime: 5 * 60_000,
  });
}

/** Catalogue lines of a held instrument's ISIN (public data, cached 5 minutes). A failure is left to the caller to treat as "no data". */
export function useCatalogueListings(isin: string | null) {
  return useQuery({
    queryKey: ["ibkr-catalogue", isin ?? "none"] as const,
    queryFn: () => handoffApi.getCatalogueListings(isin as string),
    enabled: isin !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The signed-in user's own preference. `gcTime: 0`: the value is dropped from memory as soon as nothing displays it. */
export function useDefaultDestination() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  return useQuery({
    queryKey: defaultDestinationKey(userId),
    queryFn: () => handoffApi.getDefaultDestination(userId as string),
    enabled: userId !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useSaveDefaultDestination() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const client = useQueryClient();
  return useMutation({
    mutationFn: (destination: Destination) => {
      if (userId === null) throw new Error("Sign in to save your default destination.");
      return handoffApi.setDefaultDestination(userId, destination);
    },
    onSuccess: (_void, destination) => {
      client.setQueryData(defaultDestinationKey(userId), destination);
    },
  });
}
