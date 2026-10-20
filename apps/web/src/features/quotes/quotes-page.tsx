import { DEFAULT_SETTINGS } from "@core/indicator.ts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { errorText } from "@/features/screening/errors";
import { usePriceSeries, useTodaysDiscounts } from "@/features/screening/hooks";
import { useChartBySymbol, useQuotesDetailed } from "@/features/screening/quotes-hooks";
import { formatMoney, formatSessionDate, formatSofia } from "@/lib/format";
import { AttributionNotice } from "./attribution";
import { ChannelLegend } from "./channel-legend";
import { describeChannel } from "./channel-summary";
import { ChannelValuesTable } from "./channel-values-table";
import { type Bar, barsFromArrays, computeChannelData, type RangeKey } from "./chart-data";
import { ChartToolbar } from "./chart-toolbar";
import { ExternalLinks } from "./external-links";
import { DEFAULT_VISIBILITY, type Visibility } from "./indicator-settings";
import { IndicatorSettingsPopover } from "./indicator-settings-popover";
import { pickSelection, type Selection } from "./selection";
import { type ChartType, type CrosshairLegend, StdDevChannelChart } from "./std-dev-channel-chart";
import { StockSelect, SymbolSearch } from "./stock-selector";
import { useResolvedTheme } from "./use-resolved-theme";

export function QuotesPage() {
  const search = useSearch({ from: "/quotes" });
  const navigate = useNavigate({ from: "/quotes" });
  const theme = useResolvedTheme();

  const discounts = useTodaysDiscounts();
  // Every row of the list in rank order: most of them are unscanned now, and the chart does not depend on research.
  const cards = useMemo(
    () => [...(discounts.data ?? [])].sort((a, b) => a.rank - b.rank),
    [discounts.data],
  );
  const selection = useMemo(
    () =>
      discounts.isLoading ? null : pickSelection(cards, { symbol: search.symbol, sid: search.sid }),
    [discounts.isLoading, cards, search.symbol, search.sid],
  );

  const sid = selection?.securityId ?? undefined;
  const stored = usePriceSeries(sid);
  const bySymbol = useChartBySymbol(
    selection && !selection.securityId ? selection.symbol : undefined,
  );
  const active = sid ? stored : bySymbol;
  const quote = useQuotesDetailed(selection ? [selection.symbol] : []);

  const bars: Bar[] = useMemo(() => {
    if (stored.data && sid) return barsFromArrays(stored.data);
    if (bySymbol.data && !sid) return barsFromArrays(bySymbol.data);
    return [];
  }, [stored.data, bySymbol.data, sid]);

  const [chartType, setChartType] = useState<ChartType>("candlestick");
  const [indicatorVisible, setIndicatorVisible] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [visibility, setVisibility] = useState<Visibility>(DEFAULT_VISIBILITY);
  const [rangeRequest, setRangeRequest] = useState<{ range: RangeKey; nonce: number } | null>(null);
  const [legend, setLegend] = useState<CrosshairLegend | null>(null);

  const channel = useMemo(() => computeChannelData(bars, settings), [bars, settings]);

  const select = (s: Selection) => {
    void navigate({
      search: (prev) => ({ ...prev, symbol: s.symbol, sid: s.securityId ?? undefined }),
      replace: true,
    });
  };

  const row = cards.find((c) => c.security_id === sid);
  const name = selection?.name ?? bySymbol.data?.longName ?? selection?.symbol ?? "";
  const exchangeCode = selection?.exchangeCode ?? bySymbol.data?.exchange ?? null;
  const currency = row?.currency ?? bySymbol.data?.currency ?? "";
  const last = bars[bars.length - 1];
  const q = quote.data?.quotes[0];
  // "unavailable" (and a failed 502/503 request) means retry later, never an unknown symbol.
  const quoteUnavailable =
    quote.isError ||
    (selection ? (quote.data?.unavailable.includes(selection.symbol) ?? false) : false);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Quotes</h1>

      {discounts.isLoading ? <Loading label="Loading today's list" rows={1} /> : null}
      {discounts.isError ? (
        <ErrorState message={errorText(discounts.error)} onRetry={() => void discounts.refetch()} />
      ) : null}
      {discounts.data ? (
        <div className="grid gap-4 md:grid-cols-2">
          {cards.length > 0 ? (
            <StockSelect options={cards} symbol={selection?.symbol} onSelect={select} />
          ) : (
            <EmptyState title="No stocks are in today's list. Search for a security manually." />
          )}
          <SymbolSearch onPick={select} />
        </div>
      ) : null}

      {selection ? (
        <section aria-labelledby="instrument-heading" className="space-y-3">
          <header className="space-y-1">
            <h2 id="instrument-heading" className="text-xl font-semibold">
              {name ? `${name} (${selection.symbol})` : selection.symbol}
            </h2>
            <ExternalLinks exchangeCode={exchangeCode} symbol={selection.symbol} />
            {last ? (
              <p className="text-sm tabular-nums">
                {`Last completed close ${formatMoney(last.close, currency)} · close ${formatSessionDate(last.time)}`}
              </p>
            ) : null}
            {q && q.regularMarketPrice !== null ? (
              <p className="text-sm tabular-nums text-muted-foreground">
                {`delayed quote ${formatMoney(q.regularMarketPrice, q.currency)} at ${formatSofia(q.regularMarketTime)} (${q.marketState ?? "state unknown"})`}
              </p>
            ) : null}
            {quoteUnavailable ? (
              <p role="status" className="text-sm text-muted-foreground">
                Delayed quote unavailable right now.{" "}
                <button
                  type="button"
                  onClick={() => void quote.refetch()}
                  className="min-h-9 rounded px-1 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Retry
                </button>
              </p>
            ) : null}
          </header>

          {active.isLoading ? <Loading label="Loading price history" rows={5} /> : null}
          {active.isError ? (
            <ErrorState message={errorText(active.error)} onRetry={() => void active.refetch()} />
          ) : null}

          {bars.length > 0 ? (
            <>
              <ChartToolbar
                chartType={chartType}
                onChartType={setChartType}
                onRange={(range) => setRangeRequest((r) => ({ range, nonce: (r?.nonce ?? 0) + 1 }))}
                indicatorVisible={indicatorVisible}
                onIndicatorToggle={() => setIndicatorVisible((v) => !v)}
                settings={
                  <IndicatorSettingsPopover
                    settings={settings}
                    visibility={visibility}
                    onApply={setSettings}
                    onVisibilityChange={(key, visible) =>
                      setVisibility((v) => ({ ...v, [key]: visible }))
                    }
                    onReset={() => {
                      setSettings(DEFAULT_SETTINGS);
                      setVisibility(DEFAULT_VISIBILITY);
                    }}
                  />
                }
              />
              <StdDevChannelChart
                bars={bars}
                channel={channel}
                chartType={chartType}
                indicatorVisible={indicatorVisible}
                lineVisibility={visibility}
                theme={theme}
                rangeRequest={rangeRequest}
                ariaLabel={
                  channel.status === "ok" && last
                    ? describeChannel({
                        close: last.close,
                        date: last.time,
                        channel: channel.channel,
                      })
                    : `Daily price chart for ${selection.symbol}`
                }
                onLegend={setLegend}
              />
              <ChannelLegend legend={legend} currency={currency} />
              {channel.status === "insufficient" ? (
                <p
                  role="status"
                  className="status-tag"
                  data-tone="pending"
                  data-testid="channel-notice"
                >
                  {`Not enough history for the channel (${channel.have.toLocaleString("en-US")} of ${channel.need.toLocaleString("en-US")} bars)`}
                </p>
              ) : null}
              {channel.status === "invalid" ? (
                <p
                  role="status"
                  className="status-tag"
                  data-tone="amber"
                >{`The channel could not be computed (${channel.reason}).`}</p>
              ) : null}
              {channel.status === "ok" && last ? (
                <>
                  <p className="text-sm">
                    {describeChannel({
                      close: last.close,
                      date: last.time,
                      channel: channel.channel,
                    })}
                  </p>
                  <ChannelValuesTable
                    channel={channel.channel}
                    close={last.close}
                    date={last.time}
                    currency={currency}
                  />
                </>
              ) : null}
            </>
          ) : null}
          <AttributionNotice />
        </section>
      ) : null}
    </div>
  );
}
