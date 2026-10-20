import { supabase } from "@/lib/supabase";
import { createHoldingsApi } from "./holdings-api";

export const holdingsApi = createHoldingsApi(supabase);
