import { IBKR_LOGIN_URL, TICKET_REVIEW_NOTE } from "@core/handoff.ts";
import { Check, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type CopyOutcome, copyText } from "./copy-text";
import type { Gate, HandoffView } from "./derive";

const GATE_TEXT: Record<Gate, string> = {
  needs_acknowledgement: "Tick the box above to show the prompt.",
  needs_symbol: "Enter the IBKR local symbol to show the prompt.",
  invalid_symbol: "Fix the symbol to show the prompt.",
  needs_quantity: "Enter a quantity to show the prompt.",
  needs_price: "Enter a limit price to show the prompt.",
};

/** The generated iBot prompt, a Copy button, the second (documented-style) variant, the ticket checklist and the one link out (spec 13.1, 13.2). */
export function PromptPanel({ view }: { view: HandoffView }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);

  async function onCopy() {
    if (view.prompt === null) return;
    const result = await copyText(view.prompt, box.current);
    setOutcome(result);
    if (result !== "failed") toast.success("Copied");
  }

  const copied = outcome === "clipboard" || outcome === "fallback";

  return (
    <section aria-labelledby="prompt-heading" className="grid gap-3 rounded-md border p-3">
      <h3 id="prompt-heading" className="text-sm font-semibold">
        iBot prompt
      </h3>

      {view.prompt === null ? (
        <p className="text-sm text-muted-foreground" data-testid="prompt-gate">
          {view.gate === null ? "" : GATE_TEXT[view.gate]}
        </p>
      ) : (
        <>
          {view.mode === "none" ? (
            <p
              role="alert"
              className="flex gap-2 rounded-md border border-amber-700 bg-amber-50 p-2 text-xs font-medium text-amber-950 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-50"
            >
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
              <span>
                Unverified symbol: this prompt uses a symbol the app has not checked. Confirm the
                contract on the IBKR ticket.
              </span>
            </p>
          ) : null}
          <textarea
            ref={box}
            readOnly
            rows={3}
            aria-label="iBot prompt"
            data-testid="ibot-prompt"
            className="w-full resize-none rounded-md border bg-muted/40 p-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={view.prompt}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={onCopy} data-testid="copy-prompt">
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {outcome === "failed" ? "Copy failed: the prompt is selected, press Ctrl+C." : ""}
            </span>
          </div>
          {view.checklist !== null ? (
            <p
              className="rounded-md bg-muted/60 p-2 text-sm font-medium"
              data-testid="ticket-checklist"
            >
              {view.checklist}
            </p>
          ) : null}
          {view.documented !== null ? (
            <details className="text-sm">
              <summary className="cursor-pointer rounded-sm py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Documented-style variant
              </summary>
              <p className="mt-1 font-mono" data-testid="documented-prompt">
                {view.documented.prompt}
              </p>
              <p className="text-xs text-muted-foreground">{view.documented.ticketNote}</p>
            </details>
          ) : null}
        </>
      )}

      <p className="text-xs text-muted-foreground">{TICKET_REVIEW_NOTE}</p>
      <a
        href={IBKR_LOGIN_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="open-ibkr"
      >
        Open IBKR Client Portal
        <ExternalLink aria-hidden="true" className="size-3.5" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </section>
  );
}
