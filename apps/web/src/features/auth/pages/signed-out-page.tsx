import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { AuthCard } from "../components/auth-card";

export function SignedOutPage() {
  return (
    <AuthCard title="You are signed out">
      <p>You have been signed out of this device.</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to="/auth/sign-in">Sign in again</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/">Back to Overview</Link>
        </Button>
      </div>
    </AuthCard>
  );
}
