import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PagePlaceholderProps {
  title: string;
  description: string;
  phase?: string;
}

export function PagePlaceholder({ title, description, phase }: PagePlaceholderProps) {
  return (
    <section aria-labelledby="page-title" className="space-y-4">
      <h1 id="page-title" className="font-semibold">
        {title}
      </h1>
      <p className="max-w-prose text-muted-foreground">{description}</p>
      {phase ? (
        <Card className="max-w-prose">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Not built yet <Badge variant="outline">Planned in {phase}</Badge>
            </CardTitle>
            <CardDescription>This page is a placeholder from the P0 scaffold.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The route, navigation and theme are wired; content arrives with its phase.
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
