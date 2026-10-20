import { type ReactNode, useRef, useState } from "react";

const THRESHOLD_PX = 70;

/** Simple overscroll gesture for touch devices: pull down from the top of the page, release past 70 px. The button is the primary control. */
export function PullToRefresh({
  onRefresh,
  disabled = false,
  children,
}: {
  onRefresh: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);

  return (
    <div
      data-testid="pull-area"
      onTouchStart={(e) => {
        startY.current = !disabled && window.scrollY <= 0 ? (e.touches[0]?.clientY ?? null) : null;
      }}
      onTouchMove={(e) => {
        if (startY.current === null) return;
        const dy = (e.touches[0]?.clientY ?? startY.current) - startY.current;
        setPull(dy > 0 ? Math.min(dy, 140) : 0);
      }}
      onTouchEnd={(e) => {
        const start = startY.current;
        startY.current = null;
        const dy = start === null ? 0 : (e.changedTouches[0]?.clientY ?? start) - start;
        setPull(0);
        if (start !== null && dy >= THRESHOLD_PX) onRefresh();
      }}
    >
      {pull > 0 ? (
        <p role="status" className="py-1 text-center text-xs text-muted-foreground">
          {pull >= THRESHOLD_PX ? "Release to refresh" : "Pull to refresh"}
        </p>
      ) : null}
      {children}
    </div>
  );
}
