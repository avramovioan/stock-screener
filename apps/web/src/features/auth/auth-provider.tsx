import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { AuthState, AuthStore } from "./auth-store";

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ store, children }: { store: AuthStore; children: ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
