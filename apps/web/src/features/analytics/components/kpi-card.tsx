import type { ReactNode } from "react";
import { type Provenance, ProvenanceBadge } from "../../portfolio/provenance";

export function KpiCard({
  title,
  provenance,
  note,
  children,
}: {
  title: string;
  provenance: Provenance[];
  note?: string;
  children: ReactNode;
}) {
  const id = `kpi-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <article aria-labelledby={id} className="flex flex-col gap-2 rounded-md border p-3">
      <h3 id={id} className="text-sm font-medium text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1 text-sm tabular-nums">{children}</div>
      {note !== undefined ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <footer className="mt-auto flex flex-wrap gap-1">
        {provenance.map((p) => (
          <ProvenanceBadge key={p} kind={p} />
        ))}
      </footer>
    </article>
  );
}
