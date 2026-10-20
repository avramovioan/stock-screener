import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import type { AuthFailure, SignOutScope } from "./api";
import { authApi } from "./default";
import { setSigningOut } from "./guards";

/**
 * Signs out first and navigates to /auth/signed-out only on success. While the call is in flight
 * the guard tolerates the signed-out state (no bounce to the sign-in form). On failure the user
 * stays on the current page and the mapped failure is returned.
 */
export function useSignOut() {
  const router = useRouter();
  return useCallback(
    async (scope: SignOutScope): Promise<AuthFailure | null> => {
      setSigningOut(true);
      try {
        const result = await authApi.signOut(scope);
        if (!result.ok) return result;
        await router.navigate({ to: "/auth/signed-out" });
        return null;
      } finally {
        setSigningOut(false);
      }
    },
    [router],
  );
}
