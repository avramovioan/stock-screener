import { supabase } from "@/lib/supabase";
import { type BrokerConnection, type BrokerRun, createBrokerApi } from "./broker-api";

const base = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
const CONNECTION_COLUMNS =
  "id,status,token_expires_on,query_id,account_id_masked,base_currency,account_type,linked_at,last_verified_at,last_sync_at,last_statement_date,last_error_code,last_error_message,last_error_at,coverage_from";

/** The real client. The secret columns are not selectable (spec 6.8), so they are never listed here. */
export const brokerApi = createBrokerApi({
  async readSnapshot() {
    const conn = await supabase.from("broker_connections").select(CONNECTION_COLUMNS).maybeSingle();
    if (conn.error) throw new Error("Could not load the broker connection.");
    const run = await supabase
      .from("broker_sync_runs")
      .select("id,kind,state,error_code,error_message,rows_summary,statement_from,statement_to")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run.error) throw new Error("Could not load the last sync.");
    return {
      connection: (conn.data as BrokerConnection | null) ?? null,
      run: (run.data as BrokerRun | null) ?? null,
    };
  },
  async call(body) {
    const session = (await supabase.auth.getSession()).data.session;
    return await fetch(`${base}/functions/v1/broker-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token ?? ""}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
      },
      body: JSON.stringify(body),
    });
  },
});
