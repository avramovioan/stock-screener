import { expect, type Page, test } from "@playwright/test";
import { installFakePush } from "./support/push-mock";
import { api, FAKE_PUSH_ENDPOINT, OWNER, SERVICE, signIn, userId } from "./support/stack";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installFakePush(page, FAKE_PUSH_ENDPOINT);
});

test.afterEach(async () => {
  const svc = await api(SERVICE);
  await svc.delete(
    `/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(FAKE_PUSH_ENDPOINT)}`,
  );
  await svc.dispose();
});

async function storedRow(): Promise<Record<string, unknown> | undefined> {
  const svc = await api(SERVICE);
  const res = await svc.get(
    `/rest/v1/push_subscriptions?select=user_id,topic_discounts,topic_portfolio,revoked_at&endpoint=eq.${encodeURIComponent(FAKE_PUSH_ENDPOINT)}`,
  );
  const rows = (await res.json()) as Record<string, unknown>[];
  await svc.dispose();
  return rows[0];
}

function trackSubscribeCalls(page: Page): string[] {
  const bodies: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/functions/v1/push-subscribe"))
      bodies.push(r.postData() ?? "");
  });
  return bodies;
}

test("a visitor who is not signed in registers this device from the bell, with no account", async ({
  page,
}) => {
  const bodies = trackSubscribeCalls(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Notifications on this device" }).click();
  const sheet = page.getByRole("dialog", { name: "Notifications on this phone" });
  const news = sheet.getByRole("switch", { name: "New companies on the list" });
  await expect(news).not.toBeChecked();
  await expect(sheet.getByRole("switch")).toHaveCount(1);
  await news.click();
  await expect(news).toBeChecked();
  await expect
    .poll(() => bodies.some((b) => b.includes('"subscribe"') && b.includes(FAKE_PUSH_ENDPOINT)))
    .toBe(true);
  await expect.poll(async () => (await storedRow())?.user_id).toBeNull();
  expect((await storedRow())?.topic_discounts).toBe(true);
  expect((await storedRow())?.topic_portfolio).toBe(false);

  await sheet.getByRole("button", { name: "Send a test notification" }).click();
  await expect(sheet.getByText(/Test notification sent|could not be delivered/)).toBeVisible();

  await sheet.getByRole("button", { name: "Turn off on this phone" }).click();
  await expect(news).not.toBeChecked();
  await expect.poll(() => bodies.some((b) => b.includes('"unsubscribe"'))).toBe(true);
});

test("a signed-in viewer switches on alerts about their holdings in Profile, Notifications", async ({
  page,
}) => {
  await signIn(page, OWNER);
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: "Notifications on this device" }).click();
  const sheet = page.getByRole("dialog", { name: "Notifications on this phone" });
  await expect(sheet.getByRole("switch", { name: "Alerts about my holdings" })).toHaveCount(0);
  await sheet.getByRole("switch", { name: "New companies on the list" }).click();
  await expect(sheet.getByRole("switch", { name: "New companies on the list" })).toBeChecked();
  await page.keyboard.press("Escape");
  await page.goto("/profile/notifications");
  const holdings = page.getByRole("switch", { name: "Alerts about my holdings on this device" });
  await expect(holdings).toBeEnabled();
  await holdings.click();
  await expect(holdings).toBeChecked();
  const row = await storedRow();
  expect(row?.user_id).toBe(await userId(OWNER.email));
  expect(row?.topic_portfolio).toBe(true);
  expect(row?.topic_discounts).toBe(true);
});
