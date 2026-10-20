import type { SupabaseClient } from "@supabase/supabase-js";

/** What a held line links to besides its valuation: the company's canonical listing and, when monitored, its research state. */
export interface HoldingLink {
  conid: number;
  /** `securities.id` of the company's canonical listing (broker_positions.signal_security_id); null for a holding that is not screened. */
  securityId: string | null;
  /** Yahoo symbol of the canonical listing; null for a holding that is not screened. */
  symbol: string | null;
  /** The statement line itself (symbol, listing exchange, conid): the trade target of an unscreened holding. */
  held?: {
    symbol: string;
    listingExchange: string | null;
    conid: number;
    description: string | null;
    currency: string;
  };
  /** ISIN of the held line (statement). */
  isin?: string | null;
  /** The screened company's canonical listing as shown in the ticker box; absent for a holding that is not screened. */
  screened?: { exchangeCode: string | null; exchangeName: string | null; rank: number | null };
  monitor: {
    reportId: string | null;
    fullReportDate: string | null;
    lastCheckDate: string | null;
  } | null;
}

export interface HoldingsApi {
  links(): Promise<Map<number, HoldingLink>>;
}

interface PositionRow {
  conid: number | string;
  symbol: string;
  description: string | null;
  currency: string;
  listing_exchange: string | null;
  isin?: string | null;
  signal_security_id: string | null;
  securities: {
    yahoo_symbol: string | null;
    exchange_code?: string | null;
    exchanges?: { name: string | null } | null;
  } | null;
}
interface MonitorRow {
  security_id: string;
  last_check_at: string | null;
  last_report_id: string | null;
  research_reports: { completed_at: string | null } | null;
}

const day = (v: string | null | undefined): string | null => (v ? v.slice(0, 10) : null);

/** The worldwide rank of each screened company in the latest scan; a failure only means the box shows no rank. */
async function latestRanks(
  client: Pick<SupabaseClient, "from">,
  ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  try {
    const { data, error } = await client
      .from("universe_snapshots")
      .select("security_id, rank, scan_run_id")
      .eq("mode", "worldwide")
      .in("security_id", ids)
      .order("ranked_at", { ascending: false })
      .limit(2000);
    if (error) return out;
    const rows = (data ?? []) as unknown as {
      security_id: string;
      rank: number;
      scan_run_id: string;
    }[];
    const newest = rows[0]?.scan_run_id; // rows are newest first: only the latest worldwide scan counts
    for (const r of rows)
      if (r.scan_run_id === newest && !out.has(r.security_id)) out.set(r.security_id, r.rank);
  } catch {
    // no rank line
  }
  return out;
}

/** Read under RLS: the user's own positions (newest statement first) and risk_monitor_state rows. Failures throw; the page treats them as "no extras". */
export function createHoldingsApi(client: Pick<SupabaseClient, "from">): HoldingsApi {
  return {
    async links() {
      const [pos, mon] = await Promise.all([
        client
          .from("broker_positions")
          .select(
            "conid, symbol, description, isin, currency, listing_exchange, signal_security_id, securities!signal_security_id(yahoo_symbol, exchange_code, exchanges(name))",
          )
          .order("report_date", { ascending: false })
          .limit(1000),
        client
          .from("risk_monitor_state")
          .select("security_id, last_check_at, last_report_id, research_reports(completed_at)"),
      ]);
      if (pos.error || mon.error) throw new Error("Could not load the holding links.");
      const monitors = new Map<string, MonitorRow>();
      for (const m of (mon.data ?? []) as unknown as MonitorRow[]) monitors.set(m.security_id, m);
      const ranks = await latestRanks(
        client,
        [
          ...new Set(
            ((pos.data ?? []) as unknown as PositionRow[]).map((p) => p.signal_security_id),
          ),
        ].filter((id): id is string => id !== null),
      );
      const out = new Map<number, HoldingLink>();
      for (const p of (pos.data ?? []) as unknown as PositionRow[]) {
        const conid = Number(p.conid);
        const symbol = p.securities?.yahoo_symbol ?? null;
        if (out.has(conid)) continue;
        const screened = p.signal_security_id !== null && symbol !== null;
        const m = p.signal_security_id === null ? undefined : monitors.get(p.signal_security_id);
        out.set(conid, {
          conid,
          securityId: screened ? p.signal_security_id : null,
          symbol: screened ? symbol : null,
          isin: p.isin ?? null,
          ...(screened
            ? {
                screened: {
                  exchangeCode: p.securities?.exchange_code ?? null,
                  exchangeName: p.securities?.exchanges?.name ?? null,
                  rank: ranks.get(p.signal_security_id as string) ?? null,
                },
              }
            : {}),
          held: {
            symbol: p.symbol,
            listingExchange: p.listing_exchange,
            conid,
            description: p.description,
            currency: p.currency,
          },
          monitor:
            m === undefined || !screened
              ? null
              : {
                  reportId: m.last_report_id,
                  fullReportDate: day(m.research_reports?.completed_at),
                  lastCheckDate: day(m.last_check_at),
                },
        });
      }
      return out;
    },
  };
}
