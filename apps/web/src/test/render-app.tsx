import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AuthState } from "@/features/auth/auth-store";
import { AppProviders } from "@/providers";
import { createAppRouter } from "@/router";
import { createFakeAuthStore, signedOut } from "./auth-fixtures";

export async function renderApp(path: string, initial: Partial<AuthState> = signedOut) {
  const store = createFakeAuthStore(initial);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }), store);
  await router.load();
  render(
    <AppProviders authStore={store} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { router, store, queryClient };
}

export function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Submits the form that contains the named button (a click on a submit button is not reliable in happy-dom). */
export function submit(buttonName: string) {
  const form = screen.getByRole("button", { name: buttonName }).closest("form");
  if (form === null) throw new Error(`Button "${buttonName}" is not inside a form`);
  fireEvent.submit(form);
}
