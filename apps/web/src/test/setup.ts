import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// supabase.ts reads these at import time; the values are dummies and no request is made.
vi.stubEnv("VITE_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");

// The real default.ts would start a Supabase client (timers, storage) in every test file that imports
// the router. A vi.mock in a setup file applies to every test file.
vi.mock(
  "@/features/auth/default",
  async () => (await import("./auth-default-mock")).authDefaultMock,
);
vi.mock(
  "@/features/profile/default",
  async () => (await import("./profile-default-mock")).profileDefaultMock,
);

vi.mock(
  "@/features/handoff/default",
  async () => (await import("./handoff-default-mock")).handoffDefaultMock,
);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});
