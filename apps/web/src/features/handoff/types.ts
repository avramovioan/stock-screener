import type { Money } from "@core/portfolio-view.ts";

/** What the owner holds of the instrument, shown as the "Your position" card (portfolio rows only). */
export interface HeldPosition {
  quantity: number;
  averageCost: number | null;
  currency: string;
  marketValue: Money;
  unrealized: Money;
  heldSymbol: string;
  heldExchange: string | null;
  reportDate: string | null;
}

/** What the dialog needs to know about the instrument being traded: the CANONICAL (screening) listing of the company. */
export interface TradeTarget {
  /** `securities.id` of the canonical listing: `eur_equivalents` rows hang off it. */
  securityId: string;
  /** Yahoo symbol of the screening listing, e.g. `MSFT`. */
  symbol: string;
  companyName: string;
  /** Rank at scan time (cards); null for a holding that is not in today's list. */
  rank: number | null;
  exchangeName: string | null;
  currency: string | null;
  /** Yahoo exchange code of the screening listing (`NMS`, `PAR`): with `listingCountry` it gives the home ticker (RMS.PA -> RMS). */
  exchangeCode?: string | null | undefined;
  listingCountry?: string | null | undefined;
  /** The card's last close in `currency`: prefills the limit price when the prompt routes to the home market. */
  closePrice?: number | null | undefined;
  position?: HeldPosition | undefined;
}

/**
 * The instrument a holding line actually is (statement symbol, listing exchange and conid), for a position that maps to no screened
 * company. The dialog shows it as the destination: no EUR lookup, no verification panel.
 */
export interface HeldTarget {
  kind: "held";
  /** IBKR symbol from the statement (`broker_positions.symbol`). */
  symbol: string;
  /** Statement listing exchange; null when the statement has none. */
  listingExchange: string | null;
  conid: number;
  description: string | null;
  currency: string;
  /** `broker_positions.isin`: lets the hand-off look up the Xetra listing of the same instrument. */
  isin?: string | null | undefined;
  position?: HeldPosition | undefined;
}

export function isHeldTarget(target: TradeTarget | HeldTarget): target is HeldTarget {
  return "kind" in target && target.kind === "held";
}
