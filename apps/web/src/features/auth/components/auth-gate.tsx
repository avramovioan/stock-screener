import type { ReactNode } from "react";
import { useAuth } from "../auth-provider";
import { AuthSkeleton } from "./auth-skeleton";

/** Renders children only for a signed-in user that is not in password recovery. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, recovery } = useAuth();
  if (status !== "signed-in" || recovery) return <AuthSkeleton />;
  return <>{children}</>;
}
