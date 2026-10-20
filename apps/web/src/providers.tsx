import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/features/auth/auth-provider";
import type { AuthStore } from "@/features/auth/auth-store";
import { authStore as defaultAuthStore } from "@/features/auth/default";
import { PushSessionReconcile } from "@/features/notifications/session-reconcile";
import { queryClient as defaultQueryClient } from "@/lib/query-client";

interface AppProvidersProps {
  children: ReactNode;
  queryClient?: QueryClient;
  authStore?: AuthStore;
}

export function AppProviders({
  children,
  queryClient = defaultQueryClient,
  authStore = defaultAuthStore,
}: AppProvidersProps) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider store={authStore}>
          <TooltipProvider>
            <PushSessionReconcile />
            {children}
            <Toaster />
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
