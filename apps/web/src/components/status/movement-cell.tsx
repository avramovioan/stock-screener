import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { formatPct } from "@/lib/format";

export function movementOf(
  pct: number | null | undefined,
): { dir: "up" | "down" | "flat"; abs: string; text: string } | null {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const rounded = Number(pct.toFixed(2));
  const dir = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  return { dir, abs: Math.abs(rounded).toFixed(2), text: formatPct(pct) };
}

/** Sign + arrow + spoken label; colour only reinforces. */
export function MovementCell({ pct }: { pct: number | null | undefined }) {
  const move = movementOf(pct);
  if (move === null) {
    return (
      <span className="text-muted-foreground" role="img" aria-label="Movement unavailable">
        n/a
      </span>
    );
  }
  const label =
    move.dir === "up"
      ? `Up ${move.abs} percent`
      : move.dir === "down"
        ? `Down ${move.abs} percent`
        : "Unchanged";
  const Icon = move.dir === "up" ? ArrowUp : move.dir === "down" ? ArrowDown : Minus;
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${move.dir === "up" ? "move-up" : move.dir === "down" ? "move-down" : ""}`}
      role="img"
      aria-label={label}
    >
      <Icon aria-hidden="true" size={14} />
      <span aria-hidden="true">{move.text}</span>
    </span>
  );
}
