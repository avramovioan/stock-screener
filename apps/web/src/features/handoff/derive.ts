import {
  allowedDestinations,
  buildDocumentedStylePrompt,
  buildIbotPrompt,
  chooseDestination,
  type Destination,
  type Estimate,
  type EurListing,
  estimateValue,
  formatEuro,
  formatPriceForPrompt,
  localSymbolProblem,
  type OrderType,
  parsePriceInput,
  parseQuantityInput,
  pickListing,
  type Side,
  ticketChecklist,
} from "@core/handoff.ts";
import { type HeldRoute, heldDestination } from "./held-destination";
import type { HeldTarget } from "./types";

/** Everything the hand-off dialog shows is derived here from plain inputs, so the rules (spec 13.1-13.4) are testable without React. */

export interface FormState {
  side: Side;
  orderType: OrderType;
  quantityText: string;
  priceText: string;
  /** null until the user touches the selector: the profile default then applies and may be adjusted with a reason (spec 13.3). */
  destination: Destination | null;
  acknowledged: boolean;
  manualSymbol: string;
}

export const INITIAL_FORM: FormState = {
  side: "buy",
  orderType: "limit",
  quantityText: "",
  priceText: "",
  destination: null,
  acknowledged: false,
  manualSymbol: "",
};

export type ListingMode = "verified" | "unverified" | "none" | "held";
export type Gate =
  | "needs_acknowledgement"
  | "needs_symbol"
  | "invalid_symbol"
  | "needs_quantity"
  | "needs_price";

export interface HandoffView {
  mode: ListingMode;
  /** The EUR line shown (best of the stored rows); null on the `none` path. */
  listing: EurListing | null;
  localSymbol: string | null;
  conid: number | null;
  /** An IBKR destination code; for a held instrument the statement exchange (or SMART). */
  destination: string;
  destinationOptions: Destination[];
  destinationNote: string | null;
  /** Why no prompt is shown yet; null when the prompt is ready. */
  gate: Gate | null;
  errors: { quantity: string | null; price: string | null; symbol: string | null };
  prompt: string | null;
  documented: { prompt: string; ticketNote: string } | null;
  estimate: Estimate;
  checklist: string | null;
}

export interface DeriveInput {
  listings: readonly EurListing[];
  form: FormState;
  defaultDestination: Destination;
  /** The verified EUR delayed quote, if any: only used to estimate a market order. */
  referencePrice: number | null;
}

export function deriveHandoff(input: DeriveInput): HandoffView {
  const { form } = input;
  const best = pickListing(input.listings);
  const listing = best !== null && best.status !== "none" ? best : null;
  const mode: ListingMode =
    listing === null ? "none" : listing.status === "verified" ? "verified" : "unverified";

  // destination (13.3): only venues that list the shown instrument; the default is adjusted with a reason, an explicit choice is kept
  const exchanges = listing === null ? [] : [listing.exchange];
  const options = allowedDestinations(exchanges);
  const wanted = form.destination ?? input.defaultDestination;
  const adjusted = chooseDestination(wanted, exchanges);
  const destination = options.includes(wanted) ? wanted : adjusted.destination;
  const destinationNote = form.destination === null && adjusted.adjusted ? adjusted.reason : null;

  // local symbol: from the catalogue row, or typed by the user on the `none` path (clearly unverified)
  const manual = form.manualSymbol.trim().toUpperCase();
  const localSymbol = listing !== null ? listing.localSymbol : manual === "" ? null : manual;
  const conid = listing !== null ? listing.conid : null;

  const qty = parseQuantityInput(form.quantityText);
  const price = parsePriceInput(form.priceText);
  const errors = {
    quantity: form.quantityText.trim() === "" || qty.ok ? null : qty.message,
    price:
      form.orderType === "market" || form.priceText.trim() === "" || price.ok
        ? null
        : price.message,
    symbol: null as string | null,
  };

  let gate: Gate | null = null;
  if (mode === "unverified" && !form.acknowledged) gate = "needs_acknowledgement";
  else if (localSymbol === null) gate = "needs_symbol";
  else if (localSymbolProblem(localSymbol) !== null) {
    gate = "invalid_symbol";
    errors.symbol = localSymbolProblem(localSymbol);
  } else if (!qty.ok) gate = "needs_quantity";
  else if (form.orderType === "limit" && !price.ok) gate = "needs_price";

  let prompt: string | null = null;
  let documented: HandoffView["documented"] = null;
  if (gate === null && localSymbol !== null && qty.ok) {
    const ibot = {
      side: form.side,
      orderType: form.orderType,
      quantity: qty.value,
      localSymbol,
      price: price.ok ? price.value : undefined,
      destination,
    };
    const built = buildIbotPrompt(ibot);
    if (built.ok) prompt = built.prompt;
    const doc = buildDocumentedStylePrompt(ibot);
    if (doc.ok) documented = { prompt: doc.prompt, ticketNote: doc.ticketNote };
  }

  return {
    mode,
    listing,
    localSymbol,
    conid,
    destination,
    destinationOptions: options,
    destinationNote,
    gate,
    errors,
    prompt,
    documented,
    estimate: estimateValue({
      orderType: form.orderType,
      quantity: qty.ok ? qty.value : 0,
      price: price.ok ? price.value : undefined,
      referencePrice: input.referencePrice,
    }),
    checklist:
      prompt !== null && localSymbol !== null
        ? ticketChecklist({ conid, localSymbol, destination })
        : null,
  };
}

export interface DeriveHeldInput {
  target: HeldTarget;
  form: FormState;
  /** The chosen route (catalogue-aware); without it the statement's listing exchange and conid apply. */
  route?: HeldRoute | undefined;
}

/** The hand-off for a held instrument: the statement symbol, listing exchange and conid are the destination (no EUR rows involved). */
export function deriveHeldHandoff({ target, form, route }: DeriveHeldInput): HandoffView {
  const destination = route?.destination ?? heldDestination(target.listingExchange).destination;
  const localSymbol = (route?.localSymbol ?? target.symbol).trim().toUpperCase();
  const currency = route?.currency ?? target.currency;
  const qty = parseQuantityInput(form.quantityText);
  const price = parsePriceInput(form.priceText);
  const errors = {
    quantity: form.quantityText.trim() === "" || qty.ok ? null : qty.message,
    price:
      form.orderType === "market" || form.priceText.trim() === "" || price.ok
        ? null
        : price.message,
    symbol: localSymbolProblem(localSymbol),
  };

  let gate: Gate | null = null;
  if (errors.symbol !== null) gate = "invalid_symbol";
  else if (!qty.ok) gate = "needs_quantity";
  else if (form.orderType === "limit" && !price.ok) gate = "needs_price";

  let prompt: string | null = null;
  let documented: HandoffView["documented"] = null;
  if (gate === null && qty.ok) {
    const at =
      form.orderType === "limit" && price.ok ? ` at ${formatPriceForPrompt(price.value)}` : "";
    prompt = `Create ${form.side} ${form.orderType} order for ${qty.value} shares of ${localSymbol}${at} and set destination ${destination}`;
    const verb = form.side === "buy" ? "Buy" : "Sell";
    const tail =
      form.orderType === "limit" && price.ok
        ? `at ${formatPriceForPrompt(price.value)} limit`
        : "at market";
    documented = {
      prompt: `${verb} ${qty.value} shares of ${localSymbol} ${tail}`,
      ticketNote: `On the ticket set the destination to ${destination}.`,
    };
  }

  const estimate: Estimate =
    form.orderType === "limit" && qty.ok && price.ok
      ? (() => {
          const amount = Math.round(qty.value * price.value * 100) / 100;
          return {
            amount,
            basis: "limit price" as const,
            label: `Estimate before fees: ${formatEuro(amount)} ${currency} (${qty.value} x ${formatPriceForPrompt(price.value)}, limit price); commissions not included`,
          };
        })()
      : { amount: null, basis: null, label: "Estimate before fees: not available" };

  return {
    mode: "held",
    listing: null,
    localSymbol,
    conid: route?.conid ?? target.conid,
    destination,
    destinationOptions: [],
    destinationNote: null,
    gate,
    errors,
    prompt,
    documented,
    estimate,
    checklist:
      prompt === null
        ? null
        : `On the ticket confirm: conid ${route?.conid ?? target.conid} / ${localSymbol} / ${currency} / destination ${destination}`,
  };
}
