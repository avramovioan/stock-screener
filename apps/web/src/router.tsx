import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { AboutPage } from "@/features/about/about-page";
import { AnalyticsPage } from "@/features/analytics/analytics-page";
import type { AuthStore } from "@/features/auth/auth-store";
import { AuthGate } from "@/features/auth/components/auth-gate";
import { authStore } from "@/features/auth/default";
import { requireAuth } from "@/features/auth/guards";
import { SignInPage } from "@/features/auth/pages/sign-in-page";
import { SignedOutPage } from "@/features/auth/pages/signed-out-page";
import { HowItWorksPage } from "@/features/how-it-works/how-it-works-page";
import { OverviewPage } from "@/features/overview/overview-page";
import { NotFoundPage } from "@/features/pages";
import { PortfolioPage } from "@/features/portfolio/page/portfolio-page";
import { validatePortfolioSearch } from "@/features/portfolio/page/search-params";
import { ProfileBrokerPage } from "@/features/profile/broker-page";
import { ProfileNotificationsPage } from "@/features/profile/notifications-page";
import { ProfileLayout } from "@/features/profile/profile-layout";
import { SecurityPage } from "@/features/profile/security/security-page";
import { QuotesPage } from "@/features/quotes/quotes-page";
import { ReportPage } from "@/features/research/ReportPage";
import { validateOverviewSearch, validateQuotesSearch } from "@/features/screening/search-params";

export interface RouterContext {
  auth: AuthStore;
}

const nextSchema = z.object({ next: z.string().max(512).optional().catch(undefined) });

/** Search validation: keeps `next` only when it is a string. Pages still pass it through safeNext. */
function parseNext(search: Record<string, unknown>): { next?: string } {
  const { next } = nextSchema.parse(search);
  return next === undefined ? {} : { next };
}

function guarded(Page: ComponentType) {
  return function GuardedPage() {
    return (
      <AuthGate>
        <Page />
      </AuthGate>
    );
  };
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateOverviewSearch,
  component: OverviewPage,
});
const quotesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/quotes",
  validateSearch: validateQuotesSearch,
  component: QuotesPage,
});
const portfolioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/portfolio",
  validateSearch: validatePortfolioSearch,
  beforeLoad: requireAuth,
  component: guarded(PortfolioPage),
});
const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  beforeLoad: requireAuth,
  component: guarded(AnalyticsPage),
});
const researchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/research/$reportId",
  component: ReportPage,
});
const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutPage,
});
const howItWorksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/how-it-works",
  component: HowItWorksPage,
});
// Profile: the layout route carries the guard, so every child is protected (spec 11.5).
const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  beforeLoad: requireAuth,
  component: ProfileLayout,
});
// spec 14.1: /profile redirects to /profile/security
const profileIndexRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/profile/security" });
  },
});
const profileSecurityRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: "security",
  component: SecurityPage,
});
const profileBrokerRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: "broker",
  component: ProfileBrokerPage,
});
const profileNotificationsRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: "notifications",
  component: ProfileNotificationsPage,
});
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/sign-in",
  validateSearch: parseNext,
  component: SignInPage,
});
const signedOutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/signed-out",
  component: SignedOutPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  quotesRoute,
  portfolioRoute,
  analyticsRoute,
  researchRoute,
  aboutRoute,
  howItWorksRoute,
  profileRoute.addChildren([
    profileIndexRoute,
    profileSecurityRoute,
    profileBrokerRoute,
    profileNotificationsRoute,
  ]),
  signInRoute,
  signedOutRoute,
]);

export function createAppRouter(history?: RouterHistory, auth: AuthStore = authStore) {
  return createRouter({
    routeTree,
    context: { auth },
    defaultPreload: "intent",
    ...(history ? { history } : {}),
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
