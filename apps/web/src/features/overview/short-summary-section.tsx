import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { Popover } from "@/components/popover";
import { errorText } from "@/features/screening/errors";
import { useShortSummary } from "@/features/screening/hooks";
import type { SummaryCompany } from "@/features/screening/types";
import { formatSessionDate } from "@/lib/format";

function Group({ label, items }: { label: string; items: SummaryCompany[] }) {
  return (
    <li className="flex items-center gap-2">
      <Popover
        trigger={`${label}: ${items.length}`}
        triggerLabel={`${label}: ${items.length}`}
        panelLabel={label}
      >
        {items.length === 0 ? (
          <p>None in this period.</p>
        ) : (
          <ul className="space-y-1">
            {items.map((c) => (
              <li key={`${c.company_id}-${c.date ?? ""}`}>
                {c.name}
                {c.date ? (
                  <span className="text-muted-foreground">{` (${formatSessionDate(c.date)})`}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </li>
  );
}

export function ShortSummarySection() {
  const q = useShortSummary();
  return (
    <section aria-labelledby="short-summary-heading" className="space-y-2">
      <h3 id="short-summary-heading" className="text-lg font-semibold">
        The short summary
      </h3>
      {q.isLoading ? <Loading label="Loading the short summary" rows={2} /> : null}
      {q.isError ? (
        <ErrorState message={errorText(q.error)} onRetry={() => void q.refetch()} />
      ) : null}
      {q.data && q.data.as_of === null ? (
        <EmptyState
          title="The summary is not available yet"
          description="It appears after the first published company list."
        />
      ) : null}
      {q.data && q.data.as_of !== null ? (
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Group label="Added today" items={q.data.added_today} />
          <Group label="Removed today" items={q.data.removed_today} />
          <Group label="Added in the last 7 days" items={q.data.added_7d} />
          <Group label="Removed in the last 7 days" items={q.data.removed_7d} />
        </ul>
      ) : null}
    </section>
  );
}
