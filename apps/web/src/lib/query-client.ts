import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/features/screening/errors";

/** Retry transient failures only: a denied (401, 403, RLS) or rate-limited request will not succeed by itself. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.kind === "rls_denied" || error.kind === "rate_limited"))
    return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
        refetchOnWindowFocus: false,
      },
    },
  });
}

export const queryClient = createQueryClient();
