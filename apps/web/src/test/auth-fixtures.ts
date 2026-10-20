import type { Session, User, UserIdentity } from "@supabase/supabase-js";
import type { AuthState, AuthStore } from "@/features/auth/auth-store";

export function makeIdentity(provider: string): UserIdentity {
  return {
    id: `${provider}-id`,
    user_id: "user-1",
    identity_id: `${provider}-identity`,
    identity_data: {},
    provider,
    created_at: "2026-10-01T00:00:00Z",
    last_sign_in_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-10-01T00:00:00Z",
    email: "alice@example.test",
    email_confirmed_at: "2026-10-01T00:00:00Z",
    identities: [],
    ...overrides,
  } as User;
}

export const passwordUser = makeUser({
  identities: [makeIdentity("email")],
  app_metadata: { provider: "email", providers: ["email"] },
});

export const googleUser = makeUser({
  identities: [makeIdentity("google")],
  app_metadata: { provider: "google", providers: ["google"] },
});

export const bothUser = makeUser({
  identities: [makeIdentity("google"), makeIdentity("email")],
  app_metadata: { provider: "email", providers: ["email", "google"] },
});

export function makeSession(user: User): Session {
  return {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user,
  } as Session;
}

export interface FakeAuthStore extends AuthStore {
  set(next: Partial<AuthState>): void;
}

export function createFakeAuthStore(initial: Partial<AuthState> = {}): FakeAuthStore {
  let state: AuthState = {
    status: "loading",
    session: null,
    user: null,
    recovery: false,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearRecovery() {
      state = { ...state, recovery: false };
      emit();
    },
    dispose() {
      listeners.clear();
    },
    set(next) {
      state = { ...state, ...next };
      emit();
    },
  };
}

/** Initial state of the store before supabase-js has reported: status "loading". */
export const loading: Partial<AuthState> = {};

export const signedOut: Partial<AuthState> = {
  status: "signed-out",
  session: null,
  user: null,
  recovery: false,
};

export function signedIn(
  user: User = passwordUser,
  extra: Partial<AuthState> = {},
): Partial<AuthState> {
  return { status: "signed-in", session: makeSession(user), user, recovery: false, ...extra };
}
