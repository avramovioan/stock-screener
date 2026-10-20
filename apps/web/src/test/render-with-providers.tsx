import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { AuthProvider } from "@/features/auth/auth-provider";
import type { AuthState } from "@/features/auth/auth-store";
import { createFakeAuthStore, signedOut } from "./auth-fixtures";

interface Options {
  /** Route path the element is mounted on (default "/"). */
  path?: string;
  /** Initial URL including search (default: path). */
  url?: string;
  validateSearch?: (raw: Record<string, unknown>) => object;
  /** Auth state the page sees (default: signed out). */
  auth?: Partial<AuthState>;
}

const STUB_PATHS = ["/", "/quotes", "/about"];

/** Renders `ui` inside a real in-memory TanStack router and a fresh QueryClient (no retries). */
export function renderWithProviders(ui: ReactElement, opts: Options = {}) {
  const path = opts.path ?? "/";
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  const rootRoute = createRootRoute();
  const main = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => ui,
    ...(opts.validateSearch ? { validateSearch: opts.validateSearch } : {}),
  });
  const stubs = STUB_PATHS.filter((p) => p !== path).map((p) =>
    createRoute({ getParentRoute: () => rootRoute, path: p, component: () => <div>stub {p}</div> }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([main, ...stubs]),
    history: createMemoryHistory({ initialEntries: [opts.url ?? path] }),
  });
  const store = createFakeAuthStore(opts.auth ?? signedOut);
  const utils = render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthProvider>,
  );
  return { ...utils, router, queryClient };
}
