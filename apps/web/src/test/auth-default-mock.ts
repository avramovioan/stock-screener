import { vi } from "vitest";
import type { AuthApi } from "@/features/auth/api";
import type { AuthStore } from "@/features/auth/auth-store";

export const authApiMock = {
  signInWithPassword: vi.fn(),
  checkAccess: vi.fn(),
  createPassword: vi.fn(),
  updatePassword: vi.fn(),
  changePassword: vi.fn(),
  signOut: vi.fn(),
  recordAudit: vi.fn(),
} satisfies Record<keyof AuthApi, unknown>;

/** Never resolves out of "loading"; tests that need state pass their own fake store to the router. */
export const inertAuthStore: AuthStore = {
  getState: () => ({ status: "loading", session: null, user: null, recovery: false }),
  subscribe: () => () => undefined,
  clearRecovery: () => undefined,
  dispose: () => undefined,
};

export const authDefaultMock = { authApi: authApiMock, authStore: inertAuthStore };
