import { Link, Outlet } from "@tanstack/react-router";
import { AuthGate } from "@/features/auth/components/auth-gate";

const SECTIONS = [
  { to: "/profile/broker", label: "Broker" },
  { to: "/profile/notifications", label: "Notifications" },
  { to: "/profile/security", label: "Security" },
] as const;

const tab =
  "inline-flex h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[status=active]:border-primary data-[status=active]:text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function ProfileLayout() {
  return (
    <AuthGate>
      <div className="space-y-6">
        <div>
          <p className="text-sm text-muted-foreground">Profile</p>
          <nav aria-label="Profile sections" className="mt-1 flex flex-wrap gap-1 border-b">
            {SECTIONS.map(({ to, label }) => (
              <Link key={to} to={to} className={tab}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <Outlet />
      </div>
    </AuthGate>
  );
}
