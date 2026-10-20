import { supabase } from "@/lib/supabase";
import { createRevalueApi } from "./revalue-api";

const base = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";

/** The real client. Vitest replaces this module with a mock in the tests that click the button. */
export const revalueApi = createRevalueApi({
  url: `${base}/functions/v1/portfolio-refresh`,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
  getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
});
