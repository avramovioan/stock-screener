import { Link } from "@tanstack/react-router";
import { LogIn, User } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useSignOut } from "@/features/auth/use-sign-out";

const focusRing =
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring";
const linkClass = `inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:font-semibold data-[status=active]:text-accent-foreground ${focusRing}`;

export function UserMenu() {
  const { status } = useAuth();
  const signOut = useSignOut();

  if (status === "loading") {
    return (
      <span
        aria-hidden="true"
        data-testid="user-menu-loading"
        className="h-10 w-24 animate-pulse rounded-md bg-muted"
      />
    );
  }
  if (status === "signed-out") {
    return (
      <Link to="/auth/sign-in" className={linkClass}>
        <LogIn className="size-4" aria-hidden="true" />
        Sign in
      </Link>
    );
  }

  async function onSignOut() {
    const failure = await signOut("local");
    if (failure) toast.error(failure.message);
  }

  return (
    <>
      <Link to="/profile" className={linkClass}>
        <User className="size-4" aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Profile</span>
      </Link>
      <Button type="button" variant="ghost" size="sm" className="h-10" onClick={onSignOut}>
        Sign out
      </Button>
    </>
  );
}
