import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TradeOnIbkrDialog } from "./trade-on-ibkr-dialog";
import type { HeldTarget, TradeTarget } from "./types";

export const TRADE_BUTTON_LABEL = "Trade on IBKR";

/** A button that opens the hand-off dialog. The dialog is mounted only while open, so no EUR or profile request is made for a closed button. */
export function TradeOnIbkrButton({
  target,
  className,
  variant = "outline",
}: {
  target: TradeTarget | HeldTarget;
  className?: string;
  variant?: "outline" | "default";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={variant}
        className={className ?? "min-h-11"}
        data-testid="trade-on-ibkr-button"
        onClick={() => setOpen(true)}
      >
        {TRADE_BUTTON_LABEL}
      </Button>
      {open ? <TradeOnIbkrDialog open onOpenChange={setOpen} target={target} /> : null}
    </>
  );
}
