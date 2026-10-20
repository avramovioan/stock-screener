import { Ban, ChevronsUp, TrendingDown, TrendingUp } from "lucide-react";

export type Valuation = "discounted" | "premium" | "extra_premium" | "unavailable";

const META = {
  discounted: { label: "Discounted", tone: "green", Icon: TrendingDown },
  premium: { label: "Premium", tone: "premium", Icon: TrendingUp },
  extra_premium: { label: "Extra premium", tone: "extra", Icon: ChevronsUp },
  unavailable: { label: "Unavailable", tone: "grey", Icon: Ban },
} as const;

export function ValuationTag({ kind }: { kind: Valuation }) {
  const { label, tone, Icon } = META[kind];
  return (
    <span className="status-tag" data-tone={tone} data-testid={`valuation-${kind}`}>
      <Icon aria-hidden="true" size={14} />
      <span>{label}</span>
    </span>
  );
}
