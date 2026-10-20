import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/features/auth/auth-provider";

/** Re-runs the route guards whenever the auth state changes (loading -> signed-out, sign-out, recovery). */
export function AuthRouteSync() {
  const { status, recovery } = useAuth();
  const router = useRouter();
  // biome-ignore lint/correctness/useExhaustiveDependencies: status and recovery are the triggers
  useEffect(() => {
    void router.invalidate();
  }, [status, recovery, router]);
  return null;
}
