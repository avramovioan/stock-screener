import { queryClient } from "@/lib/query-client";
import { supabase } from "@/lib/supabase";
import { createAuthApi } from "./api";
import { createAuthStore } from "./auth-store";

export const authStore = createAuthStore(supabase, { onSignedOut: () => queryClient.clear() });

export const authApi = createAuthApi(supabase);
