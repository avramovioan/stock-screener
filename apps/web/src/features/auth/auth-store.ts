import type { AuthChangeEvent, Session, SupabaseClient, User } from "@supabase/supabase-js";

export type AuthStatus = "loading" | "signed-out" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  /** True after a PASSWORD_RECOVERY event until the password is set. Memory only. */
  recovery: boolean;
}

export interface AuthStore {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  clearRecovery(): void;
  dispose(): void;
}

export interface AuthStoreOptions {
  onSignedOut?: () => void;
}

// biome-ignore lint/suspicious/noExplicitAny: accepts both the typed app client and untyped test doubles
type AuthClient = Pick<SupabaseClient<any, any, any>, "auth">;

const LOADING: AuthState = { status: "loading", session: null, user: null, recovery: false };

export function createAuthStore(client: AuthClient, options: AuthStoreOptions = {}): AuthStore {
  let state: AuthState = LOADING;
  const listeners = new Set<() => void>();

  const set = (next: AuthState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  // No other supabase-js call is made inside this callback (they can deadlock the auth lock).
  const apply = (event: AuthChangeEvent, session: Session | null) => {
    if (event === "SIGNED_OUT" || session === null) {
      set({ status: "signed-out", session: null, user: null, recovery: false });
      if (event === "SIGNED_OUT") options.onSignedOut?.();
      return;
    }
    set({
      status: "signed-in",
      session,
      user: session.user,
      recovery: event === "PASSWORD_RECOVERY" ? true : state.recovery,
    });
  };

  const { data } = client.auth.onAuthStateChange((event, session) => apply(event, session));

  // Safety net: if INITIAL_SESSION is never delivered the app must not stay in "loading".
  void client.auth
    .getSession()
    .then(({ data: { session } }) => {
      if (state.status === "loading") apply("INITIAL_SESSION", session);
    })
    .catch(() => {
      if (state.status === "loading") apply("INITIAL_SESSION", null);
    });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearRecovery() {
      if (state.recovery) set({ ...state, recovery: false });
    },
    dispose() {
      data.subscription.unsubscribe();
      listeners.clear();
    },
  };
}
