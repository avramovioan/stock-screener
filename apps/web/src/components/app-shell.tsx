import { Link, Outlet, useRouter } from "@tanstack/react-router";
import { Briefcase, ChartColumn, ChartLine, LayoutDashboard, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { AuthRouteSync } from "@/components/auth-route-sync";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { NotificationsBell } from "@/features/notifications/notifications-bell";
import { AttributionNotice } from "@/features/quotes/attribution";
import { registerPageChrome } from "@/lib/page-chrome";

interface NavItem {
  to: "/" | "/quotes" | "/portfolio" | "/analytics";
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/quotes", label: "Quotes", icon: ChartLine },
  { to: "/portfolio", label: "Portfolio", icon: Briefcase },
  { to: "/analytics", label: "Analytics", icon: ChartColumn },
];

const focusRing =
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring";

// 40px tall desktop targets; the current page is marked by fill and weight, never by colour alone
const topLink = `inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:font-semibold data-[status=active]:text-accent-foreground ${focusRing}`;

// 56px tall mobile targets (above the 44px minimum); active tab also gets a top indicator bar
const bottomLink = `relative flex min-h-14 flex-col items-center justify-center gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors data-[status=active]:font-semibold data-[status=active]:text-primary data-[status=active]:before:absolute data-[status=active]:before:inset-x-6 data-[status=active]:before:top-0 data-[status=active]:before:h-0.5 data-[status=active]:before:rounded-full data-[status=active]:before:bg-primary ${focusRing}`;

export function AppShell() {
  const router = useRouter();
  useEffect(() => registerPageChrome(router), [router]);
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <AuthRouteSync />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-4">
          <Link to="/" className={`rounded-md text-base font-semibold tracking-tight ${focusRing}`}>
            Stock Screener
          </Link>
          <nav aria-label="Primary" className="hidden flex-1 items-center gap-1 md:flex">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={topLink}
                activeOptions={{ exact: to === "/", includeSearch: to !== "/" }}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <NotificationsBell />
            <UserMenu />
          </div>
        </div>
      </header>

      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 outline-none md:py-8"
      >
        <Outlet />
      </main>

      <footer className="border-t py-4 pb-[calc(5rem+env(safe-area-inset-bottom))] text-xs text-muted-foreground md:pb-4">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4">
          <span>
            Prices are Yahoo Finance delayed data. AI research is generated from public sources and
            is not financial advice.
          </span>
          <AttributionNotice />
          <Link
            to="/how-it-works"
            className={`rounded-sm underline underline-offset-4 ${focusRing}`}
          >
            How it works
          </Link>
          <Link to="/about" className={`rounded-sm underline underline-offset-4 ${focusRing}`}>
            About
          </Link>
        </div>
      </footer>

      <nav
        aria-label="Mobile"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="grid grid-cols-4">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={bottomLink}
              activeOptions={{ exact: to === "/", includeSearch: to !== "/" }}
            >
              <Icon className="size-5" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
