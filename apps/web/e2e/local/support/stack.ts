import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, request } from "@playwright/test";
import {
  assertLocalStackUrl,
  E2E_PASSWORD,
  OTHER_EMAIL,
  OWNER_EMAIL,
} from "../../../../../tools/lib/e2e-env.ts";

export const API =
  process.env.E2E_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? "";
export const SERVICE = process.env.E2E_SERVICE_ROLE_KEY ?? "";
assertLocalStackUrl(API); // the specs use the service key: never against a hosted project
export const OWNER = { email: OWNER_EMAIL, password: E2E_PASSWORD };
export const OTHER = { email: OTHER_EMAIL, password: E2E_PASSWORD };
export const PUSH_HOST = process.env.E2E_PUSH_HOST ?? "push.example.test";
export const FAKE_PUSH_ENDPOINT = `https://${PUSH_HOST}/e2e/${randomUUID()}`;

export function api(key: string, bearer: string = key): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: {
      apikey: key,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
  });
}

/** A user's access token through the password grant (for direct REST probes). */
export async function accessToken(who: { email: string; password: string }): Promise<string> {
  const ctx = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { apikey: ANON, "Content-Type": "application/json" },
  });
  const res = await ctx.post("/auth/v1/token?grant_type=password", { data: who });
  expect(res.ok(), `password grant for ${who.email}`).toBe(true);
  const token = ((await res.json()) as { access_token: string }).access_token;
  await ctx.dispose();
  return token;
}

export async function userId(email: string): Promise<string> {
  const svc = await api(SERVICE);
  const res = await svc.get("/auth/v1/admin/users?per_page=200");
  const users = ((await res.json()) as { users: Array<{ id: string; email?: string }> }).users;
  await svc.dispose();
  const found = users.find((u) => u.email === email);
  expect(found, `user ${email} exists (run bun run e2e:setup)`).toBeTruthy();
  return found?.id ?? "";
}

export async function signIn(
  page: Page,
  who: { email: string; password: string } = OWNER,
  next?: string,
): Promise<void> {
  await page.goto(
    next === undefined ? "/auth/sign-in" : `/auth/sign-in?next=${encodeURIComponent(next)}`,
  );
  // step 1: the e-mail must be on the invite list (`bun run e2e:setup` lists the owner and the other user)
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // the session is stored once the app has left the sign-in page; a goto before that would drop it
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"));
}

/** Requests to the local API that are not reads: proves "no write path" claims. */
export function trackWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (r) => {
    const own = r.url().startsWith(API);
    const read =
      r.method() === "GET" ||
      r.method() === "OPTIONS" ||
      r.url().includes("/rest/v1/rpc/") ||
      r.url().includes("/functions/v1/quotes/") ||
      r.url().includes("/auth/v1/token");
    if (own && !read) writes.push(`${r.method()} ${r.url()}`);
  });
  return writes;
}

/** Uncaught page errors fail the test that installed this. */
export function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

export interface FeedRow {
  withheld: boolean;
  scan_run_id: string;
  security_id: string;
  yahoo_symbol: string;
  rank: number;
  operational_category: string;
  country: string | null;
  line3_end: number;
  line4_end: number;
  reached_line4: boolean;
  is_top10: boolean;
}

/** Today's cards as a signed-out visitor sees them. */
export async function feedRows(): Promise<FeedRow[]> {
  const ctx = await api(ANON);
  const res = await ctx.post("/rest/v1/rpc/todays_discounts_feed", {
    data: { p_mode: "worldwide" },
  });
  const rows = res.ok() ? ((await res.json()) as FeedRow[]) : [];
  await ctx.dispose();
  return rows;
}

/** Puts an e-mail on the invite list (service role); `resetPassword` makes its next sign-in ask for a new password. */
export async function invite(email: string, resetPassword = false): Promise<void> {
  const svc = await api(SERVICE);
  const res = await svc.post("/rest/v1/invited_emails", {
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    data: { email, reset_password: resetPassword },
  });
  expect(res.ok(), `invite ${email}`).toBe(true);
  await svc.dispose();
}

/** Takes an e-mail off the invite list again. */
export async function uninvite(email: string): Promise<void> {
  const svc = await api(SERVICE);
  await svc.delete(`/rest/v1/invited_emails?email=eq.${encodeURIComponent(email.toLowerCase())}`);
  await svc.dispose();
}
