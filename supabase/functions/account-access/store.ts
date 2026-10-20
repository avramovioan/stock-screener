import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccessStore } from "./handler.ts";

/** Service-role store: the invite lookup is a SQL function granted to service_role only; users go through the auth admin API. */
export function createAccessStore(sb: SupabaseClient): AccessStore {
  return {
    async lookup(email) {
      const { data, error } = await sb.rpc("account_access_lookup", { p_email: email });
      if (error) throw new Error(`account-access lookup: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as {
        invited?: boolean;
        reset_password?: boolean;
        user_id?: string | null;
      } | null;
      return {
        invited: row?.invited === true,
        resetPassword: row?.reset_password === true,
        userId: row?.user_id ?? null,
      };
    },
    async createUser(email, password) {
      const { error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
      if (!error) return "ok";
      if (error.code === "email_exists" || error.status === 422) return "exists";
      throw new Error(`account-access createUser: ${error.message}`);
    },
    async setPassword(userId, password) {
      const { error } = await sb.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error(`account-access setPassword: ${error.message}`);
    },
    async clearReset(email) {
      const { error } = await sb.rpc("account_access_clear_reset", { p_email: email });
      if (error) throw new Error(`account-access clearReset: ${error.message}`);
    },
  };
}
