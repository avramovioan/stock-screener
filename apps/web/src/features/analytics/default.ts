import { supabase } from "@/lib/supabase";
import { type AnalyticsData, loadAnalyticsData } from "./analytics-data";

/** The real loader. Vitest replaces this module with a mock in the tests that need data. */
export const analyticsApi = { load: (): Promise<AnalyticsData> => loadAnalyticsData(supabase) };
