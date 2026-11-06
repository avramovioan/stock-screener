import { isValidIsin, normalizeIsin } from "@core/esma.ts";
import { EU_EXCHANGES, findEuExchange } from "@core/eu-exchanges.ts";
import { useMutation } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, errorText } from "@/features/screening/errors";
import { ExchangeCombobox } from "./exchange-combobox";
import { checkRegulated, EsmaUnavailableError } from "./regulated-api";
import { ResultBox, UnavailableBox } from "./regulated-result";

const SLOW_MS = 5000;

function failureText(e: unknown): string {
  if (e instanceof ApiError && e.status === 400) {
    return "That ISIN or exchange was not accepted. Check both and try again.";
  }
  if (e instanceof ApiError && e.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  return errorText(e);
}

export function RegulatedPage() {
  const search = useSearch({ from: "/regulated" });
  const [isin, setIsin] = useState(search.isin ?? "");
  const [mic, setMic] = useState(search.mic ?? "");
  const [isinError, setIsinError] = useState<string | undefined>();
  const [micError, setMicError] = useState<string | undefined>();
  const check = useMutation({
    mutationFn: (v: { isin: string; mic: string }) => checkRegulated(v.isin, v.mic),
  });

  // ESMA can take up to ~45s; tell the user it has not hung
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!check.isPending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [check.isPending]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const code = normalizeIsin(isin);
    const venue = mic.trim().toUpperCase();
    const badIsin = isValidIsin(code)
      ? undefined
      : "Enter a valid 12-character ISIN, e.g. IE00BMFKG444.";
    const badMic = findEuExchange(venue) ? undefined : "Pick an exchange from the list.";
    setIsinError(badIsin);
    setMicError(badMic);
    if (badIsin || badMic) return;
    check.mutate({ isin: code, mic: venue });
  }

  const unavailable = check.error instanceof EsmaUnavailableError ? check.error : null;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Regulated?</h1>
        <p className="text-sm text-muted-foreground">
          Check whether a security is admitted to a regulated market on a European exchange. The
          answer comes from the ESMA public registers (FIRDS instruments and the venue register).
        </p>
      </header>

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="regulated-isin">ISIN</Label>
          <Input
            id="regulated-isin"
            name="regulated-isin"
            value={isin}
            maxLength={12}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setIsin(event.target.value.toUpperCase())}
            aria-invalid={isinError ? true : undefined}
            aria-describedby={isinError ? "regulated-isin-error" : undefined}
          />
          {isinError ? (
            <p id="regulated-isin-error" role="alert" className="text-sm text-destructive">
              {isinError}
            </p>
          ) : null}
        </div>
        <ExchangeCombobox
          id="regulated-mic"
          label="Exchange"
          exchanges={EU_EXCHANGES}
          value={mic}
          onChange={setMic}
          error={micError}
          hint="Type a MIC (e.g. XETR) or an exchange name."
        />
        <Button type="submit" disabled={check.isPending}>
          {check.isPending ? "Checking…" : "Check"}
        </Button>
      </form>

      {check.isPending && slow ? (
        <p role="status" className="text-sm text-muted-foreground">
          ESMA is slow to respond, still checking…
        </p>
      ) : null}

      {check.data ? (
        <>
          <ResultBox result={check.data} />
          <p className="text-xs text-muted-foreground">
            via ESMA {check.data.source === "solr" ? "register" : "register search"}
          </p>
        </>
      ) : null}
      {unavailable ? <UnavailableBox manualUrls={unavailable.manualUrls} /> : null}
      {check.isError && !unavailable ? (
        <p role="alert" className="text-sm text-destructive">
          {failureText(check.error)}
        </p>
      ) : null}
    </div>
  );
}
