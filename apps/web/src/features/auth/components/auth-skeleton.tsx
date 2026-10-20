import { Skeleton } from "@/components/ui/skeleton";

/** Neutral placeholder; deliberately shows nothing about the page it stands in for. */
export function AuthSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      data-testid="auth-skeleton"
      className="space-y-4"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full max-w-xl" />
      <Skeleton className="h-32 w-full max-w-xl" />
    </div>
  );
}
