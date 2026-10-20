import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function GoogleOnlyCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-prose">
          Your account signs in with Google; there is no password to change. Manage security in your
          Google account.
        </p>
        <Button asChild variant="outline">
          <a href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer">
            Open Google account security
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
