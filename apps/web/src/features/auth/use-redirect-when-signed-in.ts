import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "./auth-provider";
import { safeNext } from "./redirects";

/** Sends a signed-in visitor of an auth page to the validated `next` target. */
export function useRedirectWhenSignedIn(next: string | undefined): void {
  const { status, recovery } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "signed-in" && !recovery) router.history.replace(safeNext(next));
  }, [status, recovery, next, router]);
}
