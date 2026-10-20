import type { PositionView } from "@core/portfolio-view.ts";
import { buildResearchPrompt } from "@/features/overview/research-prompt";
import { decodeXmlEntities } from "@/lib/format";
import type { HoldingLink } from "./holdings-api";

/**
 * The Overview's evaluation prompt for a held line. A screened holding is named by its canonical listing; any other by its
 * statement symbol. The channel lines are not part of the portfolio data, so the prompt says they are not available.
 */
export function buildHoldingPrompt(row: PositionView, link: HoldingLink | undefined): string {
  const screened = link?.securityId != null && link.symbol != null;
  const s = row.price.source;
  const day =
    s.kind === "delayed_quote" && s.asOfMs !== null
      ? new Date(s.asOfMs).toISOString().slice(0, 10)
      : s.kind === "statement_close"
        ? s.reportDate
        : "";
  return buildResearchPrompt({
    name: decodeXmlEntities(row.name ?? row.ticker),
    yahoo_symbol: screened ? (link?.symbol as string) : row.ticker,
    exchange_code: null,
    exchange_name:
      (screened ? link?.screened?.exchangeName : null) ?? link?.held?.listingExchange ?? "unknown",
    country: null,
    close: row.price.value,
    currency: row.price.ccy,
    session_date: day,
    line3_end: null,
    line4_end: null,
  });
}
