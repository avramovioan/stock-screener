// Text copied from the NOTICE file of tradingview/lightweight-charts (the package ships none, so it
// was fetched from the repository). The NOTICE spells "Copyright (с)" with a Cyrillic small es
// (U+0441); the escape keeps that exact form visible.
export const LWC_NOTICE = "TradingView Lightweight Charts™ Copyright (с) 2025 TradingView, Inc.";
export const TRADINGVIEW_URL = "https://www.tradingview.com/";

/** The Apache-2.0 attribution notice plus the required link; used in the footer, on /quotes and on /about. */
export function AttributionNotice({
  className = "text-xs text-muted-foreground",
}: {
  className?: string;
}) {
  return (
    <p className={className}>
      {LWC_NOTICE}{" "}
      <a href={TRADINGVIEW_URL} target="_blank" rel="noopener noreferrer" className="underline">
        tradingview.com
      </a>
    </p>
  );
}
