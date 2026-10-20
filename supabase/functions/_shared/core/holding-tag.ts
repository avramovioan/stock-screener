// Valuation tag of one holding from its scan result (spec 8.5). Pure: shared by the worker's portfolio_scan stage and the
// portfolio-refresh function's on-demand re-evaluation.

import type { Channel } from "./indicator.ts";
import { classifyHolding } from "./thresholds.ts";

export interface HoldingResult {
  securityId: string;
  status: string;
  sessionDate: string | null;
  close: number | null;
  channel: { end: Channel["end"] } | null;
  quoteType: string;
  companyId: string;
}

export function tagFor(
  r: HoldingResult | undefined,
  worldwideRank: number | null,
): { tag: string; reason: string; sessionDate: string | null } {
  if (r === undefined)
    return { tag: "unavailable", reason: "no scan result for this security", sessionDate: null };
  if (r.status !== "processed" || r.channel === null) {
    return {
      tag: "unavailable",
      reason:
        r.status === "processed" ? "channel not computable" : `data ${r.status.replace("_", " ")}`,
      sessionDate: r.sessionDate,
    };
  }
  const tag = classifyHolding({
    evaluable: true,
    quoteType: r.quoteType,
    close: r.close,
    end: r.channel.end,
    worldwideRank,
  });
  if (tag === "unavailable") return { tag, reason: "not an equity", sessionDate: r.sessionDate };
  return { tag, reason: `based on close of ${r.sessionDate}`, sessionDate: r.sessionDate };
}
