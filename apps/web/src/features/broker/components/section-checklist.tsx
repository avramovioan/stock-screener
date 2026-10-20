import { Check, X } from "lucide-react";
import type { SectionReport } from "../broker-api";

/** The sections of the verification statement: found or missing, and the exact fields that are missing (spec 12.3). */
export function SectionChecklist({ sections }: { sections: SectionReport[] }) {
  return (
    <ul aria-label="Statement sections" className="space-y-1 text-sm">
      {sections.map((s) => {
        const ok = s.present && s.missingFields.length === 0;
        return (
          <li key={s.section} className="flex items-start gap-2">
            {ok ? <Check aria-hidden="true" size={16} /> : <X aria-hidden="true" size={16} />}
            <span>
              {`${s.section}: ${!s.present ? "missing" : s.missingFields.length > 0 ? "found, fields missing" : "found"}`}
              {s.missingFields.length > 0 ? (
                <span className="block text-muted-foreground">{`Missing fields: ${s.missingFields.join(", ")}`}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
