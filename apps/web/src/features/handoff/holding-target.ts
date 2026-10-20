import type { HeldPosition, HeldTarget, TradeTarget } from "./types";

export interface HoldingRef {
  /** `securities.id` of the company's canonical (screening) listing: where `eur_equivalents` rows hang. */
  canonicalSecurityId: string | null;
  canonicalSymbol: string | null;
  companyName: string;
  exchangeName?: string | null | undefined;
  currency?: string | null | undefined;
  /** The statement line itself; used as the target when the position maps to no screened company. */
  held?:
    | {
        symbol: string;
        listingExchange: string | null;
        conid: number;
        description: string | null;
        currency: string;
        isin?: string | null | undefined;
      }
    | null
    | undefined;
  /** What is held, for the "Your position" card; absent for Overview cards. */
  position?: HeldPosition | undefined;
}

/**
 * The hand-off target of a held position. It is always the company's canonical listing, never the held line itself (a holding may be
 * MSF.DE; the EUR equivalent is resolved for MSFT). An unmatched position targets the held instrument itself (the
 * statement's symbol and listing exchange); without statement data there is no target.
 */
export function holdingTarget(h: HoldingRef): TradeTarget | HeldTarget | null {
  if (h.canonicalSecurityId === null || h.canonicalSymbol === null) {
    return h.held ? { kind: "held", ...h.held, position: h.position } : null;
  }
  return {
    securityId: h.canonicalSecurityId,
    symbol: h.canonicalSymbol,
    companyName: h.companyName,
    rank: null,
    exchangeName: h.exchangeName ?? null,
    currency: h.currency ?? null,
    position: h.position,
  };
}
