import { supabase } from "@/lib/supabase";
import { createHandoffApi } from "./handoff-api";

/** The real instance. Component tests replace this module with `handoffApiMock` (see src/test/handoff-default-mock.ts). */
export const handoffApi = createHandoffApi(supabase);
