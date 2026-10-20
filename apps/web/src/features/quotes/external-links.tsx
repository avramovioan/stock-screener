import { tradingViewUrl, yahooUrl } from "@/lib/deeplinks";

/** Directly under the chart title: the same listing on TradingView and Yahoo Finance. */
export function ExternalLinks({
  exchangeCode,
  symbol,
}: {
  exchangeCode: string | null;
  symbol: string;
}) {
  const tv = exchangeCode ? tradingViewUrl(exchangeCode, symbol) : null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
      {tv ? (
        <span>
          <a href={tv.url} target="_blank" rel="noopener noreferrer" className="underline">
            View on TradingView
          </a>
          {tv.verified ? null : (
            <span className="ml-1 text-xs text-muted-foreground">(unverified mapping)</span>
          )}
        </span>
      ) : (
        <span>
          <span>View on TradingView</span>
          <span className="ml-1 text-xs text-muted-foreground">
            (no TradingView mapping for this exchange)
          </span>
        </span>
      )}
      <a href={yahooUrl(symbol)} target="_blank" rel="noopener noreferrer" className="underline">
        View on Yahoo Finance
      </a>
    </p>
  );
}
