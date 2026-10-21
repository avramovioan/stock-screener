import {
  DEFAULT_DESTINATION,
  DESTINATION_LABELS,
  type Destination,
  isDestination,
  NO_ORDER_NOTICE,
  type OrderType,
  parseQuantityInput,
  pickListing,
  type Side,
} from "@core/handoff.ts";
import { Info, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQuotes } from "@/features/screening/quotes-hooks";
import { homeTicker } from "@/lib/format";
import { deriveHandoff, deriveHeldHandoff, type FormState, INITIAL_FORM } from "./derive";
import { EurListingPanel } from "./eur-listing-panel";
import { chooseHeldRoute, type HeldRoute } from "./held-destination";
import { useCatalogueListings, useDefaultDestination, useEurListings } from "./hooks";
import { PositionCard } from "./position-card";
import { PromptPanel } from "./prompt-panel";
import { prefillPrice, usableEurQuote } from "./quote-text";
import { type HeldTarget, isHeldTarget, type TradeTarget } from "./types";
import { useCooldown } from "./use-cooldown";

const SHARE_FORMAT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 });
const REFRESH_COOLDOWN_SECONDS = 10;
const SELECT_CLASS =
  "h-11 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface TradeOnIbkrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TradeTarget | HeldTarget;
}

function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; text: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="inline-flex rounded-md border p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="sm"
          className="min-h-9 min-w-16"
          variant={value === o.value ? "default" : "ghost"}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.text}
        </Button>
      ))}
    </fieldset>
  );
}

/**
 * The "Trade on IBKR" hand-off (spec 13). It prepares text for the owner to paste into IBKR's iBot. It never places, modifies or cancels an
 * order, and the notice saying so is rendered in every state, including loading and error. Nothing typed here is logged or sent anywhere.
 */
export function TradeOnIbkrDialog({ open, onOpenChange, target }: TradeOnIbkrDialogProps) {
  const held = isHeldTarget(target) ? target : null;
  const screened = isHeldTarget(target) ? null : target;
  const listings = useEurListings(open && screened !== null ? screened.securityId : null);
  const preference = useDefaultDestination();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [priceTouched, setPriceTouched] = useState(false);
  const [symbolTouched, setSymbolTouched] = useState(false);
  const cooldown = useCooldown(REFRESH_COOLDOWN_SECONDS);

  // The delayed EUR quote is requested only for a VERIFIED listing: an unverified line could be a look-alike and must not feed a price.
  const best = useMemo(() => pickListing(listings.data ?? []), [listings.data]);
  const quoteSymbol = best !== null && best.status === "verified" ? best.eurSymbolYahoo : null;
  const quotes = useQuotes(quoteSymbol === null ? [] : [quoteSymbol]);
  const eurQuote = usableEurQuote(
    quoteSymbol === null ? undefined : quotes.data?.find((q) => q.symbol === quoteSymbol),
  );

  // prefill the limit price with the delayed quote rounded to 2 decimals, until the user types their own
  const quotePrice = eurQuote?.price ?? null;
  useEffect(() => {
    if (quotePrice !== null && !priceTouched)
      setForm((f) => ({ ...f, priceText: prefillPrice(quotePrice) }));
  }, [quotePrice, priceTouched]);

  // No EUR listing: the manual symbol starts as the screening listing's home ticker (MSFT, RMS for RMS.PA) until the user edits it.
  const home = useMemo(
    () =>
      screened === null
        ? undefined
        : {
            ticker: homeTicker(screened.symbol, screened.exchangeCode, screened.listingCountry),
            currency: screened.currency,
            exchangeName: screened.exchangeName,
          },
    [screened],
  );
  const noEurListing = listings.isSuccess && (best === null || best.status === "none");
  const homeTickerValue = home?.ticker ?? null;
  useEffect(() => {
    if (noEurListing && homeTickerValue !== null && !symbolTouched)
      setForm((f) => (f.manualSymbol === "" ? { ...f, manualSymbol: homeTickerValue } : f));
  }, [noEurListing, homeTickerValue, symbolTouched]);

  const preferred: Destination = isDestination(preference.data)
    ? preference.data
    : DEFAULT_DESTINATION;
  // A held instrument with an ISIN prefers its Xetra listing; a failed lookup falls back silently to the statement's exchange.
  const catalogue = useCatalogueListings(open && held?.isin ? held.isin : null);
  const catalogueLoading = held !== null && Boolean(held.isin) && catalogue.isLoading;
  const heldRoute: HeldRoute | null = useMemo(
    () =>
      held === null
        ? null
        : chooseHeldRoute({
            rows: catalogue.isError ? null : (catalogue.data ?? null),
            preferred,
            held,
          }),
    [held, catalogue.data, catalogue.isError, preferred],
  );
  const view = useMemo(
    () =>
      held !== null
        ? deriveHeldHandoff({ target: held, form, route: heldRoute ?? undefined })
        : deriveHandoff({
            listings: listings.data ?? [],
            form,
            defaultDestination: preferred,
            referencePrice: quotePrice,
            home,
          }),
    [held, heldRoute, listings.data, form, preferred, quotePrice, home],
  );
  // On the home route the untouched price follows the card's close (screening currency); off it, the field goes back to empty.
  const homeClose = view.homeRoute !== null ? (screened?.closePrice ?? null) : null;
  useEffect(() => {
    if (screened !== null && quotePrice === null && !priceTouched)
      setForm((f) => {
        const next = homeClose !== null ? prefillPrice(homeClose) : "";
        return f.priceText === next ? f : { ...f, priceText: next };
      });
  }, [screened, quotePrice, priceTouched, homeClose]);
  const position = target.position;
  const heldQty = position?.quantity ?? 0;
  const typedQty = parseQuantityInput(form.quantityText);
  const shortBy =
    typedQty.ok && form.side === "sell" ? Math.round((typedQty.value - heldQty) * 1e6) / 1e6 : 0;
  const sharesText = (n: number) => `${SHARE_FORMAT.format(n)} ${n === 1 ? "share" : "shares"}`;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const prefilled =
    (quotePrice !== null || homeClose !== null) && !priceTouched && form.orderType === "limit";

  function reset(next: boolean) {
    if (!next) {
      setForm(INITIAL_FORM);
      setPriceTouched(false);
      setSymbolTouched(false);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent
        className="max-h-[90vh] gap-4 overflow-y-auto sm:max-w-2xl"
        data-testid="trade-dialog"
      >
        <DialogHeader>
          <DialogTitle>Trade on IBKR</DialogTitle>
          <DialogDescription>
            {screened !== null
              ? `${screened.rank !== null ? `#${screened.rank} ` : ""}${screened.symbol} — ${screened.companyName}`
              : `${target.symbol} — ${held?.description ?? target.symbol}`}
          </DialogDescription>
        </DialogHeader>

        <p
          role="note"
          data-testid="no-order-notice"
          className="sticky top-0 z-10 flex gap-2 rounded-md border-2 border-foreground/50 bg-background p-3 text-sm font-medium shadow-sm"
        >
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{NO_ORDER_NOTICE}</span>
        </p>

        {position === undefined ? null : <PositionCard position={position} />}

        {screened !== null && listings.isLoading ? (
          <p className="text-sm text-muted-foreground" data-testid="listing-loading">
            Loading the EUR listing…
          </p>
        ) : listings.isError ? (
          <div role="alert" className="grid gap-2 text-sm" data-testid="listing-error">
            <p>Could not load the EUR listing, so no prompt can be prepared right now.</p>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={() => void listings.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            {screened !== null ? (
              <EurListingPanel
                view={view}
                acknowledged={form.acknowledged}
                onAcknowledge={(v) => set("acknowledged", v)}
                manualSymbol={form.manualSymbol}
                onManualSymbol={(v) => {
                  setSymbolTouched(true);
                  set("manualSymbol", v);
                }}
                symbolPrefilled={!symbolTouched && view.homeRoute !== null}
                screeningSymbol={screened.symbol}
                screeningCurrency={screened.currency}
                screeningExchange={screened.exchangeName}
              />
            ) : null}

            {held !== null ? (
              <section
                aria-labelledby="held-heading"
                className="grid gap-1 rounded-md border p-3 text-sm"
                data-testid="held-instrument"
              >
                <h3 id="held-heading" className="font-semibold">
                  Held instrument
                </h3>
                <p>{`${held.symbol}${held.description === null ? "" : `, ${held.description}`}`}</p>
                <p className="text-muted-foreground">
                  {`Listing exchange ${held.listingExchange ?? "not reported"}, conid ${held.conid}, ${held.currency}`}
                </p>
              </section>
            ) : null}

            {view.mode === "verified" ? (
              <section
                aria-labelledby="quote-heading"
                className="grid gap-2 rounded-md border p-3 text-sm"
                data-testid="quote-block"
              >
                <h3 id="quote-heading" className="font-semibold">
                  Quote
                </h3>
                {eurQuote !== null ? (
                  <p>
                    {`Delayed quote (Yahoo): ${prefillPrice(eurQuote.price)} EUR as of ${eurQuote.stamp}, 15 minutes or more delayed, not an IBKR price${eurQuote.stale ? " (stale)" : ""}`}
                  </p>
                ) : quotes.isLoading ? (
                  <p className="text-muted-foreground">Loading the delayed quote…</p>
                ) : (
                  <p>Quote unavailable</p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="w-fit"
                  disabled={cooldown.remaining > 0 || quotes.isFetching}
                  onClick={() => {
                    cooldown.start();
                    void quotes.refetch();
                  }}
                >
                  <RefreshCw aria-hidden="true" />
                  {cooldown.remaining > 0
                    ? `Refresh quote (${cooldown.remaining} s)`
                    : "Refresh quote"}
                </Button>
              </section>
            ) : null}

            <section aria-labelledby="order-heading" className="grid gap-3 rounded-md border p-3">
              <h3 id="order-heading" className="text-sm font-semibold">
                Order to prepare
              </h3>
              <div className="flex flex-wrap gap-3">
                <Toggle<Side>
                  label="Side"
                  value={form.side}
                  onChange={(v) => set("side", v)}
                  options={[
                    { value: "buy", text: "Buy" },
                    { value: "sell", text: "Sell" },
                  ]}
                />
                <Toggle<OrderType>
                  label="Order type"
                  value={form.orderType}
                  onChange={(v) => set("orderType", v)}
                  options={[
                    { value: "limit", text: "Limit" },
                    { value: "market", text: "Market" },
                  ]}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid content-start gap-1">
                  <Label htmlFor="quantity">Quantity (shares)</Label>
                  <Input
                    id="quantity"
                    className="h-11"
                    inputMode="numeric"
                    autoComplete="off"
                    value={form.quantityText}
                    onChange={(e) => set("quantityText", e.target.value)}
                    aria-invalid={view.errors.quantity !== null}
                    aria-describedby="quantity-error"
                  />
                  {position !== undefined &&
                  form.side === "sell" &&
                  heldQty > 0 &&
                  Number.isInteger(heldQty) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-8 w-fit border-primary text-primary max-md:min-h-11"
                      onClick={() => set("quantityText", String(heldQty))}
                    >
                      {`Use all ${sharesText(heldQty)}`}
                    </Button>
                  ) : null}
                  <p
                    id="quantity-error"
                    role={view.errors.quantity === null ? undefined : "alert"}
                    className="min-h-4 text-xs font-medium text-destructive"
                  >
                    {view.errors.quantity ?? ""}
                  </p>
                </div>
                {form.orderType === "limit" ? (
                  <div className="grid content-start gap-1">
                    <Label htmlFor="limit-price">{`Limit price (${view.homeRoute?.currency ?? heldRoute?.currency ?? held?.currency ?? "EUR"})`}</Label>
                    <Input
                      id="limit-price"
                      className="h-11"
                      inputMode="decimal"
                      autoComplete="off"
                      value={form.priceText}
                      onChange={(e) => {
                        setPriceTouched(true);
                        set("priceText", e.target.value);
                      }}
                      aria-invalid={view.errors.price !== null}
                      aria-describedby="limit-price-note"
                    />
                    <p
                      id="limit-price-note"
                      role={view.errors.price === null ? undefined : "alert"}
                      className="min-h-4 text-xs font-medium text-destructive"
                    >
                      {view.errors.price ?? ""}
                    </p>
                    {prefilled && view.errors.price === null ? (
                      <p className="text-xs text-muted-foreground">
                        {view.homeRoute !== null && quotePrice === null
                          ? "Prefilled from the card's last close: edit before use."
                          : "Prefilled from the delayed quote: edit before use."}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="self-end text-xs text-muted-foreground">
                    A market order has no price in the prompt.
                  </p>
                )}
              </div>
              {held !== null && heldRoute !== null ? (
                <div className="grid gap-1">
                  <p className="text-sm font-medium">Destination</p>
                  <p className="text-sm" data-testid="held-destination">
                    {view.destination}
                  </p>
                  {catalogueLoading ? (
                    <p className="text-xs text-muted-foreground" data-testid="destination-loading">
                      Looking for a Xetra listing…
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground" data-testid="destination-note">
                      {heldRoute.note === "xetra"
                        ? "Xetra preferred"
                        : heldRoute.note === "amsterdam"
                          ? "Amsterdam (no Xetra listing found)"
                          : heldRoute.fallback
                            ? `The statement's exchange code (${held.listingExchange ?? "none"}) is not an IBKR destination, so the prompt uses SMART.`
                            : "Listing exchange from your statement"}
                    </p>
                  )}
                </div>
              ) : view.homeRoute !== null ? (
                <p className="text-sm" data-testid="home-destination">
                  {`Destination: SMART (home market${view.homeRoute.exchangeName ? `, ${view.homeRoute.exchangeName}` : ""})`}
                </p>
              ) : (
                <div className="grid gap-1">
                  <Label htmlFor="destination">Destination</Label>
                  <select
                    id="destination"
                    className={SELECT_CLASS}
                    value={view.destination}
                    onChange={(e) => {
                      if (isDestination(e.target.value)) set("destination", e.target.value);
                    }}
                  >
                    {view.destinationOptions.map((d) => (
                      <option key={d} value={d}>{`${d} — ${DESTINATION_LABELS[d]}`}</option>
                    ))}
                  </select>
                  {view.destinationNote !== null ? (
                    <p className="text-xs text-muted-foreground" data-testid="destination-note">
                      {view.destinationNote}
                    </p>
                  ) : null}
                </div>
              )}
              {position !== undefined && shortBy > 0 ? (
                <p
                  role="status"
                  className="m-0 border-l-[3px] border-orange-600 pl-2 text-[13px] text-orange-800 dark:text-orange-300"
                >
                  {`You hold ${sharesText(heldQty)}. Selling ${SHARE_FORMAT.format(typedQty.ok ? typedQty.value : 0)} would open a short position of ${SHARE_FORMAT.format(shortBy)}.`}
                </p>
              ) : null}
              <p className="text-sm" data-testid="estimate">
                {view.estimate.label}
              </p>
            </section>

            <PromptPanel view={view} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
