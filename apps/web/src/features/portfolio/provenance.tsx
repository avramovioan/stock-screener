import { Calculator, Landmark } from "lucide-react";

export type Provenance = "broker" | "calculated";

const META = {
  broker: { label: "Broker-reported", Icon: Landmark },
  calculated: { label: "Calculated by this app", Icon: Calculator },
} as const;

/** Every analytics number says where it comes from; the label is text, the icon is decoration. */
export function ProvenanceBadge({ kind }: { kind: Provenance }) {
  const { label, Icon } = META[kind];
  return (
    <span
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
      data-testid={`provenance-${kind}`}
    >
      <Icon aria-hidden="true" size={12} />
      {label}
    </span>
  );
}
