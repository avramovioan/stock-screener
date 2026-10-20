import { supabase } from "@/lib/supabase";
import { createTradesApi } from "./trades-api";

export const tradesApi = createTradesApi(supabase);
