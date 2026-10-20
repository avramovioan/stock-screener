import type { SupabaseClient } from "@supabase/supabase-js";
import { createRefreshStore } from "./store.ts";

const base = {
  conid: 1,
  description: null,
  currency: "EUR",
  quantity: 1,
  multiplier: 1,
  cost_basis_money: null,
  cost_basis_price: null,
  mark_price: null,
  fifo_pnl_unrealized: null,
  fx_rate_to_base: null,
  report_date: "2026-10-16",
  valuation_tag: null,
  valuation_session_date: null,
  valuation_reason: null,
  match_status: "unmatched",
};

function fakeSb(rows: Array<Record<string, unknown>>): SupabaseClient {
  const chain = (result: unknown) => {
    const q = Promise.resolve(result) as Promise<unknown> & Record<string, unknown>;
    for (const m of ["select", "eq", "neq", "order", "limit", "in"]) q[m] = () => q;
    return q;
  };
  let positionCalls = 0;
  return {
    from(table: string) {
      if (table === "securities") {
        return chain({
          data: [{ id: "sec-1", yahoo_symbol: "ASML.AS" }],
          error: null,
        });
      }
      return chain(
        positionCalls++ === 0
          ? { data: [{ report_date: "2026-10-16" }], error: null }
          : { data: rows, error: null },
      );
    },
  } as unknown as SupabaseClient;
}

Deno.test("valuationSymbol falls back to the exchange-derived Yahoo symbol", async () => {
  const sb = fakeSb([
    {
      ...base,
      id: 1,
      symbol: "VUSA",
      asset_class: "ETF",
      listing_exchange: "AEB",
      security_id: null,
    },
    {
      ...base,
      id: 2,
      symbol: "XS1",
      asset_class: "BOND",
      listing_exchange: "AEB",
      security_id: null,
    },
    {
      ...base,
      id: 3,
      symbol: "ASML",
      asset_class: "STK",
      listing_exchange: "AEB",
      security_id: "sec-1",
    },
  ]);
  const out = await createRefreshStore(sb).loadLatestPositions("u1");
  const by = (s: string) => out.find((p) => p.symbol === s)?.valuationSymbol;
  if (by("VUSA") !== "VUSA.AS") throw new Error(`VUSA got ${by("VUSA")}`);
  if (by("XS1") !== null) throw new Error(`bond got ${by("XS1")}`);
  if (by("ASML") !== "ASML.AS") throw new Error(`ASML got ${by("ASML")}`);
});
