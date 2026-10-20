import { CircleCheck, CircleHelp, Hourglass, OctagonX, TriangleAlert } from "lucide-react";

export type Category = "green" | "amber" | "red" | "grey" | "pending";

const META = {
  green: { label: "Meets checks", Icon: CircleCheck },
  amber: { label: "Caution", Icon: TriangleAlert },
  red: { label: "Not cleared", Icon: OctagonX },
  grey: { label: "Inconclusive", Icon: CircleHelp },
  pending: { label: "Research pending", Icon: Hourglass },
} as const;

export const AMBER_LONG_LABEL = "Caution: moderate bankruptcy risk";

export function categoryLabel(category: Category, long = false): string {
  return category === "amber" && long ? AMBER_LONG_LABEL : META[category].label;
}

/** Colour + icon + text; the text is the meaning, the colour is decoration. */
export function CategoryBadge({ category, long = false }: { category: Category; long?: boolean }) {
  const { Icon } = META[category];
  const label = categoryLabel(category, long);
  return (
    <span
      className="status-tag"
      data-tone={category}
      data-testid={`category-${category}`}
      role="img"
      aria-label={`Category: ${label}`}
    >
      <Icon aria-hidden="true" size={14} />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
