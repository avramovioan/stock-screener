import type { User } from "@supabase/supabase-js";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/features/auth/auth-provider";
import { hasPasswordIdentity, isGoogleOnly, providersOf } from "@/features/auth/identity";
import { DisplayNameCard } from "./display-name-card";
import { GoogleOnlyCard } from "./google-only-card";
import { PasswordCard } from "./password-card";
import { SessionsCard } from "./sessions-card";

const PROVIDER_LABELS: Record<string, string> = { email: "Email and password", google: "Google" };

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function EmailCard({ user }: { user: User }) {
  const verified = Boolean(user.email_confirmed_at);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>The address you sign in with. It cannot be changed here.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <p className="break-all font-medium">{user.email}</p>
        {verified ? <Badge>Verified</Badge> : <Badge variant="outline">Not verified</Badge>}
      </CardContent>
    </Card>
  );
}

function ProvidersCard({ user }: { user: User }) {
  const providers = providersOf(user);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-in methods</CardTitle>
      </CardHeader>
      <CardContent>
        <ul aria-label="Linked sign-in methods" className="list-disc space-y-1 pl-5">
          {providers.map((provider) => (
            <li key={provider}>{providerLabel(provider)}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function NoPasswordCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <p>Password changes are not available for this account.</p>
      </CardContent>
    </Card>
  );
}

export function SecurityPage() {
  const { user } = useAuth();
  if (user === null) return null;

  // The password form exists ONLY for accounts with an email identity (spec 11.4).
  let passwordSection = <NoPasswordCard />;
  if (hasPasswordIdentity(user)) passwordSection = <PasswordCard email={user.email ?? ""} />;
  else if (isGoogleOnly(user)) passwordSection = <GoogleOnlyCard />;

  return (
    <section aria-labelledby="page-title" className="max-w-2xl space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Security
      </h1>
      <EmailCard user={user} />
      <DisplayNameCard userId={user.id} />
      {passwordSection}
      <ProvidersCard user={user} />
      <SessionsCard />
    </section>
  );
}
