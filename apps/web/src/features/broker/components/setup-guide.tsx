import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FLEX_SECTIONS, LIMITS, REQUIREMENTS, SETUP_STEPS } from "../setup-content";

export function SetupGuide() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>How to set up IBKR Flex</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ol className="list-decimal space-y-2 pl-5">
            {SETUP_STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <details>
            <summary className="cursor-pointer font-medium">
              Sections and fields to include in the query
            </summary>
            <div className="mt-2 space-y-3">
              {FLEX_SECTIONS.map((s) => (
                <div key={s.section}>
                  <h4 className="font-medium">{s.section}</h4>
                  <p className="text-muted-foreground">{s.fields.join(", ")}</p>
                  {s.note ? <p>{s.note}</p> : null}
                </div>
              ))}
            </div>
          </details>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Requirements</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {REQUIREMENTS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What this cannot do</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {LIMITS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
