import type { AnyRouter } from "@tanstack/react-router";

const SUFFIX = "Stock Screener";

const TITLES: Record<string, string> = {
  "/": "Overview",
  "/quotes": "Quotes",
  "/about": "About",
  "/portfolio": "Portfolio",
  "/analytics": "Analytics",
  "/profile/security": "Security",
  "/profile/broker": "Broker",
  "/profile/notifications": "Notifications",
  "/auth/sign-in": "Sign in",
  "/auth/signed-out": "You are signed out",
};

/** "<Page> · Stock Screener"; unknown paths are the not-found page. */
export function titleForPath(pathname: string): string {
  const key = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (/^\/research\/[^/]+$/.test(key)) return `Research report · ${SUFFIX}`;
  return `${TITLES[key] ?? "Page not found"} · ${SUFFIX}`;
}

/** Moves focus to the page heading (fallback: main) so keyboard and screen reader users land on the new page. */
export function focusPageHeading(): void {
  const target =
    document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("main");
  if (target === null) return;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

/**
 * Registers the once-per-router page chrome: document.title after every resolved navigation and
 * focus on the heading after every navigation except the initial load. Returns the unsubscribe.
 */
export function registerPageChrome(router: AnyRouter): () => void {
  document.title = titleForPath(router.state.location.pathname);
  return router.subscribe("onResolved", ({ toLocation, fromLocation, pathChanged }) => {
    document.title = titleForPath(toLocation.pathname);
    if (fromLocation === undefined || !pathChanged) return;
    // Wait for React to commit the new page before looking for its heading.
    setTimeout(focusPageHeading, 0);
  });
}
