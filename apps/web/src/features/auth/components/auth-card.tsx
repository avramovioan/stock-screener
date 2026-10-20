import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";

interface AuthCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** Footer link style: 44px tall touch target, underlined, visible focus ring. */
export const AUTH_LINK =
  "inline-flex min-h-11 items-center rounded-sm underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <section aria-labelledby="auth-title" className="mx-auto w-full max-w-md py-6">
      <Card>
        <CardHeader>
          <h1 id="auth-title" className="text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
        {footer ? (
          <CardFooter className="flex flex-col items-start gap-1 text-sm">{footer}</CardFooter>
        ) : null}
      </Card>
    </section>
  );
}
