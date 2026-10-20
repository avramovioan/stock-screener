import type { PositionView } from "@core/portfolio-view.ts";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatSofiaShort } from "@/lib/format";
import { buildHoldingPrompt } from "./holding-prompt";
import type { HoldingLink } from "./holdings-api";
import { revalueApi } from "./revalue-default";

const COPIED_MS = 2000;
const ICON_BUTTON =
  "inline-flex size-9 items-center justify-center rounded-lg border bg-card text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:bg-muted max-md:size-11";

/** Re-evaluates one screened holding against today's channel (the server allows it once a day). */
function ReevaluateButton({
  row,
  link,
  onRevalued,
}: {
  row: PositionView;
  link: HoldingLink | undefined;
  onRevalued: (() => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const screened = link !== undefined && link.securityId !== null;
  if (!screened)
    return (
      <button
        type="button"
        disabled
        aria-label="Re-evaluate is only for screened companies"
        className={ICON_BUTTON}
      >
        <RefreshCw aria-hidden="true" size={16} />
      </button>
    );
  const run = async () => {
    setBusy(true);
    try {
      const result = await revalueApi.revalue(row.conid);
      if (result.kind === "ok") {
        setBlocked(null);
        onRevalued?.();
      } else if (result.kind === "cooldown") {
        const note =
          result.nextAllowedAt === null
            ? "Re-evaluated already today"
            : `Re-evaluated already today; next at ${formatSofiaShort(result.nextAllowedAt)}`;
        setBlocked(note);
        toast.info(note);
      } else toast.error(result.message);
    } catch {
      toast.error("The re-evaluation failed. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-label={`Re-evaluate ${row.ticker} against today's channel`}
        title={blocked ?? "Re-evaluate (once a day)"}
        onClick={() => void run()}
        className={ICON_BUTTON}
      >
        <RefreshCw aria-hidden="true" size={16} className={busy ? "animate-spin" : undefined} />
      </button>
      {blocked === null ? null : (
        <span role="status" className="sr-only">
          {blocked}
        </span>
      )}
    </>
  );
}

/** Copies the evaluation prompt of the holding, "Copied" feedback as on the Overview cards. */
function CopyPromptButton({ row, link }: { row: PositionView; link: HoldingLink | undefined }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildHoldingPrompt(row, link));
    } catch {
      return; // no clipboard access: nothing was copied
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  const Icon = copied ? Check : Copy;
  return (
    <>
      <button
        type="button"
        aria-label={`Copy the evaluation prompt for ${row.ticker}`}
        title="Copy the prompt"
        onClick={() => void copy()}
        className={ICON_BUTTON}
      >
        <Icon aria-hidden="true" size={16} />
      </button>
      {copied ? (
        <span role="status" className="sr-only">
          Copied
        </span>
      ) : null}
    </>
  );
}

/** The two icon buttons under the Trade button. */
export function HoldingActions({
  row,
  link,
  onRevalued,
}: {
  row: PositionView;
  link: HoldingLink | undefined;
  onRevalued?: (() => void) | undefined;
}) {
  return (
    <div className="flex justify-center gap-1.5 max-md:gap-2">
      <ReevaluateButton row={row} link={link} onRevalued={onRevalued} />
      <CopyPromptButton row={row} link={link} />
    </div>
  );
}
