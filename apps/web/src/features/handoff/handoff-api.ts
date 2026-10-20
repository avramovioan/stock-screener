import {
  DEFAULT_DESTINATION,
  type Destination,
  type EurExchange,
  type EurListing,
  type EurStatus,
  isDestination,
} from "@core/handoff.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogueRow } from "./held-destination";

const COLUMNS =
  "ibkr_exchange_id, status, ibkr_conid, ibkr_local_symbol, isin, eur_symbol_yahoo, verification, verified_at";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** One `eur_equivalents` row (public read, RLS `using (true)`) to the core type; anything unexpected is dropped, never guessed. */
export function parseEurListing(raw: unknown): EurListing | null {
  if (!isRecord(raw)) return null;
  const exchange = raw["ibkr_exchange_id"];
  const status = raw["status"];
  if (exchange !== "IBIS" && exchange !== "AEB") return null;
  if (status !== "verified" && status !== "unverified" && status !== "none") return null;
  const conid = raw["ibkr_conid"];
  return {
    exchange: exchange as EurExchange,
    status: status as EurStatus,
    conid: typeof conid === "number" && Number.isSafeInteger(conid) ? conid : null,
    localSymbol: str(raw["ibkr_local_symbol"]),
    isin: str(raw["isin"]),
    eurSymbolYahoo: str(raw["eur_symbol_yahoo"]),
    verifiedAt: str(raw["verified_at"]),
    verification: isRecord(raw["verification"]) ? raw["verification"] : {},
  };
}

/** One `ibkr_catalogue` row (anon-readable); unknown exchanges and malformed rows are dropped. */
export function parseCatalogueRow(raw: unknown): CatalogueRow | null {
  if (!isRecord(raw)) return null;
  const exchange = raw["exchange_id"];
  const conid = raw["conid"];
  const localSymbol = str(raw["local_symbol"]);
  const currency = str(raw["currency"]);
  if (exchange !== "IBIS" && exchange !== "AEB") return null;
  if (typeof conid !== "number" || !Number.isSafeInteger(conid)) return null;
  if (localSymbol === null || currency === null) return null;
  return { exchange, conid, localSymbol, currency };
}

/** Reads and writes for the hand-off, through the anon-key client (RLS decides): EUR lines are public, the destination is the caller's own row. */
export function createHandoffApi(client: Pick<SupabaseClient, "from">) {
  return {
    async getEurListings(securityId: string): Promise<EurListing[]> {
      const { data, error } = await client
        .from("eur_equivalents")
        .select(COLUMNS)
        .eq("security_id", securityId);
      if (error) throw new Error("Could not load the EUR listing.");
      return (data ?? []).map(parseEurListing).filter((l): l is EurListing => l !== null);
    },

    /** The Xetra and Amsterdam catalogue lines of one ISIN. */
    async getCatalogueListings(isin: string): Promise<CatalogueRow[]> {
      const { data, error } = await client
        .from("ibkr_catalogue")
        .select("exchange_id, conid, local_symbol, currency")
        .eq("isin", isin);
      if (error) throw new Error("Could not load the IBKR catalogue.");
      return (data ?? []).map(parseCatalogueRow).filter((r): r is CatalogueRow => r !== null);
    },

    async getDefaultDestination(userId: string): Promise<Destination> {
      const { data, error } = await client
        .from("profiles")
        .select("default_destination")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error("Could not load your default destination.");
      const value = (data as { default_destination?: unknown } | null)?.default_destination;
      return isDestination(value) ? value : DEFAULT_DESTINATION;
    },

    async setDefaultDestination(userId: string, destination: Destination): Promise<void> {
      if (!isDestination(destination)) throw new Error("Choose IBIS2, IBIS or AEB.");
      const { error } = await client
        .from("profiles")
        .update({ default_destination: destination })
        .eq("user_id", userId);
      if (error) throw new Error("Could not save your default destination.");
    },
  };
}

export type HandoffApi = ReturnType<typeof createHandoffApi>;
