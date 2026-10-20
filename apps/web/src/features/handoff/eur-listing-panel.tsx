import { DESTINATION_LABELS, type EurExchange } from "@core/handoff.ts";
import { Ban, CircleCheck, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HandoffView } from "./derive";
import { formatUtcStamp } from "./quote-text";

const EXCHANGE_NAMES: Record<EurExchange, string> = {
  IBIS: DESTINATION_LABELS.IBIS,
  AEB: DESTINATION_LABELS.AEB,
};

const CHECK_LABELS: Record<string, string> = {
  isin_confirmed: "ISIN confirmed against Yahoo's primary listing",
  currency_eur: "Trades in EUR",
  quote_type_equity: "Ordinary equity (not an ETF or tracker)",
  name_match: "Company name matches",
  shares_outstanding: "Shares outstanding are equal",
  price_within_tolerance: "EUR price within 1% of the screening listing",
  local_symbol_format: "IBKR local symbol is usable in a prompt",
};
const RESULT_TEXT: Record<string, string> = {
  pass: "passed",
  fail: "failed",
  not_available: "not available",
};

const BADGE =
  "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium";
const WARNING_BOX =
  "border-amber-700 bg-amber-50 text-amber-950 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-50";

export function ListingBadge({ mode }: { mode: HandoffView["mode"] }) {
  if (mode === "verified") {
    return (
      <span className={BADGE} data-testid="listing-badge" data-status="verified">
        <CircleCheck aria-hidden="true" className="size-3.5" />
        Verified
      </span>
    );
  }
  if (mode === "unverified") {
    return (
      <span
        className={`${BADGE} ${WARNING_BOX}`}
        data-testid="listing-badge"
        data-status="unverified"
      >
        <TriangleAlert aria-hidden="true" className="size-3.5" />
        Unverified
      </span>
    );
  }
  return (
    <span className={BADGE} data-testid="listing-badge" data-status="none">
      <Ban aria-hidden="true" className="size-3.5" />
      None
    </span>
  );
}

function failedLabels(verification: Record<string, unknown>): string[] {
  const failed = verification["failed"];
  return Array.isArray(failed) ? failed.map((n) => CHECK_LABELS[String(n)] ?? String(n)) : [];
}

function Checks({ verification }: { verification: Record<string, unknown> }) {
  if (verification["method"] === "manual_override") {
    return (
      <p className="text-xs text-muted-foreground">{`Confirmed manually by the operator: ${String(verification["reason"] ?? "no reason recorded")}`}</p>
    );
  }
  const checks = verification["checks"];
  if (typeof checks !== "object" || checks === null) return null;
  return (
    <ul className="grid gap-0.5 text-xs text-muted-foreground" aria-label="Verification checks">
      {Object.entries(checks as Record<string, unknown>).map(([name, result]) => (
        <li
          key={name}
        >{`${CHECK_LABELS[name] ?? name}: ${RESULT_TEXT[String(result)] ?? String(result)}`}</li>
      ))}
    </ul>
  );
}

export interface EurListingPanelProps {
  view: HandoffView;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  manualSymbol: string;
  onManualSymbol: (value: string) => void;
  screeningSymbol: string;
  screeningCurrency: string | null;
  screeningExchange: string | null;
}

/** The EUR line to use (spec 13.1) and what to do when it is unverified (13.4) or missing. */
export function EurListingPanel(p: EurListingPanelProps) {
  const { view } = p;
  const listing = view.listing;
  return (
    <section aria-labelledby="eur-listing-heading" className="grid gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="eur-listing-heading" className="text-sm font-semibold">
          EUR listing
        </h3>
        <ListingBadge mode={view.mode} />
      </div>

      {listing !== null ? (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">IBKR local symbol</dt>
            <dd className="font-mono">{listing.localSymbol}</dd>
            <dt className="text-muted-foreground">Exchange</dt>
            <dd>{`${listing.exchange} (${EXCHANGE_NAMES[listing.exchange]})`}</dd>
            <dt className="text-muted-foreground">Contract (conid)</dt>
            <dd className="font-mono">{listing.conid}</dd>
            <dt className="text-muted-foreground">ISIN</dt>
            <dd className="font-mono">{listing.isin ?? "unknown"}</dd>
            <dt className="text-muted-foreground">Currency</dt>
            <dd>EUR</dd>
            {listing.verifiedAt !== null ? (
              <>
                <dt className="text-muted-foreground">Verified</dt>
                <dd>{formatUtcStamp(Date.parse(listing.verifiedAt))}</dd>
              </>
            ) : null}
          </dl>
          <Checks verification={listing.verification} />
        </>
      ) : null}

      {view.mode === "unverified" ? (
        <div role="alert" className={`grid gap-3 rounded-md border p-3 text-sm ${WARNING_BOX}`}>
          <p className="flex gap-2">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              {`A possible EUR listing was found but could not be fully verified: ${failedLabels(listing?.verification ?? {}).join("; ") || "some checks could not run"}.`}
            </span>
          </p>
          <label className="flex min-h-11 items-center gap-3 font-medium">
            <input
              type="checkbox"
              className="size-5 shrink-0 accent-current"
              checked={p.acknowledged}
              onChange={(e) => p.onAcknowledge(e.target.checked)}
            />
            <span>I have checked this is the same share</span>
          </label>
        </div>
      ) : null}

      {view.mode === "none" ? (
        <div className="grid gap-3 text-sm">
          <p className="font-medium">No verified EUR equivalent</p>
          <p className="text-muted-foreground">
            {`Screening listing: ${p.screeningSymbol}${p.screeningExchange ? `, ${p.screeningExchange}` : ""}${p.screeningCurrency ? `, ${p.screeningCurrency}` : ""}. Search for it in IBKR yourself, or type the IBKR local symbol of a EUR listing below.`}
          </p>
          <div className="grid gap-1">
            <Label htmlFor="manual-symbol">IBKR local symbol (unverified)</Label>
            <Input
              id="manual-symbol"
              value={p.manualSymbol}
              onChange={(e) => p.onManualSymbol(e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="manual-symbol-note"
            />
            <p id="manual-symbol-note" className="text-xs">
              <span className="font-medium">Unverified symbol.</span> The app has not checked it:
              confirm the contract on the IBKR ticket.
            </p>
            {view.errors.symbol !== null ? (
              <p role="alert" className="text-xs font-medium text-destructive">
                {view.errors.symbol}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {listing !== null && view.errors.symbol !== null ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {view.errors.symbol}
        </p>
      ) : null}
    </section>
  );
}
