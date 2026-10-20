import { expect, type Page, type Route } from "@playwright/test";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
};

async function reply(route: Route, json: unknown) {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  return route.fulfill({ status: 200, headers: CORS, json });
}

export const SCAN_STATUS = {
  last_attempted: {
    scan_date_local: "2026-10-15",
    started_at: "2026-10-15T07:00:00Z",
    status: "complete",
  },
  last_successful: { scan_date_local: "2026-10-15", finished_at: "2026-10-15T07:41:00Z" },
  latest_published: {
    scan_date_local: "2026-10-15",
    status: "complete",
    latest_session_date: "2026-10-14",
    coverage: {
      candidates: { total: 40, processed: 40, unprocessed: 0 },
      publish: { results: true, list: true, list_coverage: 1 },
    },
    results_published_at: "2026-10-15T07:41:00Z",
    list_published_at: "2026-10-15T07:41:00Z",
  },
};

function discount(over: Record<string, unknown>) {
  return {
    scan_run_id: "run-1",
    mode: "worldwide",
    display_order: 1,
    withheld: false,
    exchange_name: "NasdaqGS",
    close: 412.5,
    currency: "USD",
    session_date: "2026-10-14",
    threshold_line: "-3",
    lower_line_end: 415,
    line3_end: 415,
    line4_end: 400,
    reached_line4: false,
    is_top10: Number(over.rank) <= 10,
    data_freshness: "fresh",
    is_new_episode: true,
    since_date: "2026-10-14",
    operational_category: "green",
    category_reason: "Research complete",
    conclusion: "No red flags found in public filings.",
    bankruptcy_risk: "Low",
    summary: "Cloud and software company.",
    research_completed_at: "2026-10-15T08:00:00Z",
    report_id: null,
    eur_symbol_yahoo: null,
    ibkr_local_symbol: null,
    ibkr_exchange_id: null,
    eur_status: null,
    eur_verified_at: null,
    research_provider: "gemini",
    research_model: "gemini-3.5-flash",
    fallback_reason: null,
    evidence_trimmed: null,
    wait_reason: null,
    last_attempt_at: null,
    next_attempt_at: null,
    next_provider: null,
    country: "United States",
    listing_country: over.country ?? "United States",
    research_started_at: null,
    research_wait_reason: null,
    research_requested_by: null,
    research_failed_at: null,
    ...over,
  };
}
export const DISCOUNTS = [
  discount({
    rank: 3,
    security_id: "sid-msft",
    yahoo_symbol: "MSFT",
    name: "Microsoft Corporation",
    exchange_code: "NMS",
  }),
  discount({
    rank: 5,
    security_id: "sid-asml",
    yahoo_symbol: "ASML.AS",
    name: "ASML Holding",
    exchange_code: "AMS",
    exchange_name: "Euronext Amsterdam",
    country: "Netherlands",
    currency: "EUR",
    close: 640.2,
    lower_line_end: 650,
    line3_end: 650,
    line4_end: 620,
    display_order: 2,
  }),
  discount({
    rank: 6,
    security_id: "sid-toyota",
    yahoo_symbol: "7203.T",
    name: "Toyota Motor Corporation",
    exchange_code: "JPX",
    exchange_name: "Tokyo",
    country: "Japan",
    currency: "JPY",
    close: 2790,
    lower_line_end: 2850,
    line3_end: 2850,
    line4_end: 2700,
    display_order: 5,
  }),
  discount({
    rank: 9,
    security_id: "sid-amber",
    yahoo_symbol: "AMBR",
    name: "Amber Industries",
    exchange_code: "NYQ",
    operational_category: "amber",
    bankruptcy_risk: "Moderate",
    display_order: 3,
  }),
  discount({
    rank: 7,
    security_id: "sid-red",
    yahoo_symbol: "REDX",
    name: "Red Flag Corp",
    exchange_code: "NYQ",
    operational_category: "red",
    withheld: true,
    category_reason: "bankruptcy_high",
    summary: "Going-concern doubt in the latest annual report.",
    bankruptcy_risk: "High",
    display_order: 4,
  }),
  discount({
    rank: 11,
    security_id: "sid-pending",
    yahoo_symbol: "PEND",
    name: "Pending Holdings",
    exchange_code: "NYQ",
    operational_category: "pending",
    category_reason: "research_pending",
    close: 398,
    reached_line4: true,
    withheld: true,
    conclusion: null,
    bankruptcy_risk: null,
    summary: null,
    research_completed_at: null,
    research_provider: null,
    research_model: null,
    wait_reason: "provider_unavailable",
    last_attempt_at: "2026-10-15T08:00:00Z",
    next_attempt_at: "2026-10-15T11:10:00Z",
    next_provider: "mistral-large-latest",
    display_order: 6,
  }),
  discount({
    rank: 12,
    security_id: "sid-wait",
    yahoo_symbol: "WAIT",
    name: "Waiting Industries",
    exchange_code: "NYQ",
    country: "Japan",
    close: 410,
    display_order: 7,
  }),
];

const COUNTRIES = ["Japan", "Germany", "Netherlands", "Taiwan"];

export const COMPANIES = Array.from({ length: 40 }, (_, i) => ({
  rank: i + 1,
  company_id: `c${i + 1}`,
  security_id: `s${i + 1}`,
  yahoo_symbol: `T${i + 1}`,
  name: `Company ${i + 1}`,
  currency: "USD",
  last_close: 100 + i,
  prev_close: 99 + i,
  change_pct: i % 3 === 0 ? -0.8 : 1.2,
  session_date: "2026-10-14",
  price_freshness: i === 4 ? "stale" : "fresh",
  market_cap_usd: 2e12 - i * 3e10,
  market_cap_native: 2e12 - i * 3e10,
  market_cap_ccy: "USD",
  is_top10: i < 10,
  applicable_line: null,
  lower_line_positive: null,
  is_discount: false,
  state: "member",
  country: i % 2 === 0 ? "United States" : (COUNTRIES[i % COUNTRIES.length] ?? "Japan"),
  listing_country: i % 2 === 0 ? "United States" : (COUNTRIES[i % COUNTRIES.length] ?? "Japan"),
}));

export const SUMMARY = {
  as_of: "2026-10-15",
  added_today: [{ company_id: "c40", name: "Company 40" }],
  removed_today: [],
  added_7d: [{ company_id: "c40", name: "Company 40", date: "2026-10-15" }],
  removed_7d: [{ company_id: "c99", name: "Old Co", date: "2026-10-13" }],
};

/** 2,600 weekday bars ending 2026-10-14 (enough for the 2,500-bar channel). */
export function priceSeries(securityId: string) {
  const n = 2600;
  const end = Date.UTC(2026, 9, 14) / 86_400_000;
  const days: number[] = [];
  for (let d = end; days.length < n; d--) {
    const dow = (4 + d) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
    if (dow !== 0 && dow !== 6) days.unshift(d);
  }
  const close = days.map((_, i) => 100 + i * 0.01 + Math.sin(i / 15) * 3);
  return {
    security_id: securityId,
    bar_dates: days,
    open: close,
    high: close.map((c) => c + 1),
    low: close.map((c) => c - 1),
    close,
    volume: close.map(() => 1000),
    bar_count: n,
    first_bar_date: "2016-01-04",
    last_bar_date: "2026-10-14",
    last_session_date: "2026-10-14",
    last_close: close[n - 1],
    prev_close: close[n - 2],
    freshness: "fresh",
  };
}

/** Stubs every backend call the public pages make. The pages are tested against fixed data, not a live stack. */
export async function stubApi(page: Page) {
  await page.route("**/rest/v1/rpc/scan_status", (r) => reply(r, SCAN_STATUS));
  await page.route("**/rest/v1/rpc/todays_discounts_feed", (r) => reply(r, DISCOUNTS));
  await page.route("**/rest/v1/rpc/universe_summary", (r) => reply(r, SUMMARY));
  await page.route("**/rest/v1/rpc/company_list", async (r) => {
    if (r.request().method() === "OPTIONS") return reply(r, null);
    const body = r.request().postDataJSON() as {
      p_after_rank: number | null;
      p_limit: number;
      p_country?: string | null;
    };
    const remaining = COMPANIES.filter(
      (c) => c.rank > (body.p_after_rank ?? 0) && (!body.p_country || c.country === body.p_country),
    );
    return reply(
      r,
      remaining.slice(0, body.p_limit).map((c) => ({ ...c, total_count: remaining.length })),
    );
  });
  await page.route("**/rest/v1/rpc/get_price_series", async (r) => {
    if (r.request().method() === "OPTIONS") return reply(r, null);
    const body = r.request().postDataJSON() as { p_security_id: string };
    return reply(r, priceSeries(body.p_security_id));
  });
  await page.route("**/functions/v1/quotes/**", async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith("/search")) {
      return reply(r, {
        hits: [
          {
            symbol: "NVDA",
            exchange: "NMS",
            quoteType: "EQUITY",
            longName: "NVIDIA Corporation",
            shortName: "NVIDIA",
          },
        ],
        fetchedAt: "2026-10-15T08:00:00Z",
        stale: false,
      });
    }
    if (url.pathname.endsWith("/quote"))
      return reply(r, { quotes: [], missing: [], fetchedAt: "2026-10-15T08:00:00Z", stale: false });
    const { bar_dates, open, high, low, close, volume } = priceSeries("x");
    return reply(r, {
      symbol: url.searchParams.get("symbol"),
      currency: "USD",
      exchange: "NMS",
      exchangeTimezoneName: "America/New_York",
      longName: "NVIDIA Corporation",
      bar_dates,
      open,
      high,
      low,
      close,
      volume,
      regularMarketTime: null,
      marketState: "CLOSED",
      fetchedAt: "2026-10-15T08:00:00Z",
      stale: false,
    });
  });
}

export const STUB_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "stub@example.com",
  email_confirmed_at: "2026-10-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  identities: [{ id: "i1", user_id: "u1", provider: "email", identity_data: {} }],
  created_at: "2026-10-01T00:00:00Z",
};

/**
 * Backs a signed-in visitor: the password grant, the own profile row (read and PATCH) and the auth calls the app makes.
 * `patches` collects the bodies of profile updates so a spec can assert what was written.
 */
export async function stubSignedIn(page: Page) {
  const patches: unknown[] = [];
  await page.route("**/auth/v1/token**", (r) =>
    reply(r, {
      access_token: "stub-access-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "stub-refresh-token",
      user: STUB_USER,
    }),
  );
  await page.route("**/auth/v1/user**", (r) => reply(r, STUB_USER));
  await page.route("**/rest/v1/profiles**", async (r) => {
    const method = r.request().method();
    if (method === "OPTIONS") return reply(r, null);
    if (method === "PATCH") {
      patches.push(r.request().postDataJSON());
      return r.fulfill({ status: 204, headers: CORS });
    }
    return reply(r, { user_id: STUB_USER.id, display_name: null });
  });
  await page.route("**/rest/v1/broker_connections**", (r) => reply(r, []));
  return { patches };
}

/**
 * Backs the e-mail-first sign-in: `account-access` answers the list check (and the password creation) the way the
 * contract says. `status` is what the invite list says about the e-mail the spec types.
 */
export async function stubAccess(
  page: Page,
  status: "create_password" | "sign_in" | "not_possible" = "sign_in",
) {
  await page.route("**/functions/v1/account-access", async (r) => {
    if (r.request().method() === "OPTIONS") return reply(r, null);
    const body = r.request().postDataJSON() as { action?: string };
    if (body.action === "set_password") return reply(r, { ok: true });
    return reply(r, { status });
  });
}

/** Signs in through the real two-step form; the list check is answered by `stubAccess`, the password grant by `stubSignedIn`. */
export async function signInThroughForm(page: Page, next = "/") {
  await stubAccess(page, "sign_in");
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("E-mail").fill(STUB_USER.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"));
}
