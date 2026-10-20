import { supabase } from "@/lib/supabase";
import { createProfileApi } from "./profile-api";

export const profileApi = createProfileApi(supabase);
