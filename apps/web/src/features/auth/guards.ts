import { redirect } from "@tanstack/react-router";
import type { AuthStore } from "./auth-store";
import { nextSearch, safeNext } from "./redirects";

let signingOut = false;

/** True while a sign-out call is in flight; the guard then lets the (now signed-out) page be. */
export function setSigningOut(value: boolean): void {
  signingOut = value;
}

export interface GuardArgs {
  context: { auth: AuthStore };
  location: { href: string };
}

/**
 * beforeLoad guard for protected routes. While auth state is "loading" it lets the route load; the
 * route component is wrapped in <AuthGate>, which shows a skeleton and never the protected content,
 * and AuthRouteSync re-runs this guard (router.invalidate) when the state resolves.
 */
export function requireAuth({ context, location }: GuardArgs): void {
  if (signingOut) return;
  const state = context.auth.getState();
  if (state.status === "signed-out") {
    throw redirect({ to: "/auth/sign-in", search: nextSearch(safeNext(location.href)) });
  }
}
